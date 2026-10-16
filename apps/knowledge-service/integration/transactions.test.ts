import { afterAll, beforeAll, expect, it } from 'vitest'
import { createKnowledgePrincipal } from '../src/identity'
import { withKnowledgeTransaction } from '../src/runtime/transaction'
import type { KnowledgeTransactionPool } from '../src/runtime/transaction'
import { openLocalDatabase } from './local-database'
import { removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('transactions')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

const principal = (owner: string, now = Date.now()) =>
  createKnowledgePrincipal(
    {
      issuer: 'https://synthetic.invalid',
      audiences: ['local-knowledge'],
      subject: owner,
      expiresAt: now + 60000,
      permissions: [],
    },
    { issuer: 'https://synthetic.invalid', audience: 'local-knowledge' },
    now,
  )

it('reuses one real connection A to B after COMMIT without leaking the transaction owner', async () => {
  const { pool } = await openLocalDatabase('api')
  try {
    const before = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    for (const owner of fixture.owners) {
      const result = await withKnowledgeTransaction(pool, principal(owner), (transaction) =>
        transaction.query('SELECT owner_id, pg_backend_pid() AS pid FROM knowledge.kb_quotas'),
      )
      expect(result.rows).toEqual([{ owner_id: owner, pid: before.rows[0]?.pid }])
      const outside = await pool.query(
        "SELECT NULLIF(current_setting('knowledge.owner_id', true), '') AS owner",
      )
      expect(outside.rows).toEqual([{ owner: null }])
      expect((await pool.query('SELECT owner_id FROM knowledge.kb_quotas')).rows).toEqual([])
    }
  } finally {
    await pool.end()
  }
})

it('rolls back actual writes and reuses the clean connection for the next owner', async () => {
  const { pool } = await openLocalDatabase('api')
  try {
    const before = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await expect(
      withKnowledgeTransaction(pool, principal(fixture.owners[0]), async (transaction) => {
        await transaction.query("UPDATE knowledge.kb_spaces SET title = 'Must roll back'")
        throw new Error('synthetic failure')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const own = await withKnowledgeTransaction(pool, principal(fixture.owners[0]), (transaction) =>
      transaction.query('SELECT title FROM knowledge.kb_spaces'),
    )
    expect(own.rows).toEqual([{ title: 'Synthetic space' }])
    const next = await withKnowledgeTransaction(pool, principal(fixture.owners[1]), (transaction) =>
      transaction.query('SELECT owner_id, pg_backend_pid() AS pid FROM knowledge.kb_quotas'),
    )
    expect(next.rows).toEqual([{ owner_id: fixture.owners[1], pid: before.rows[0]?.pid }])
  } finally {
    await pool.end()
  }
})

it('evicts a genuinely contaminated session instead of silently clearing its owner', async () => {
  const { pool } = await openLocalDatabase('api')
  try {
    const dirty = await pool.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid, set_config('knowledge.owner_id', $1, false)",
      [fixture.owners[0]],
    )
    let called = false
    await expect(
      withKnowledgeTransaction(pool, principal(fixture.owners[1]), async () => {
        called = true
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(called).toBe(false)
    const clean = await pool.query<{ pid: number; owner: string | null }>(
      "SELECT pg_backend_pid() AS pid, NULLIF(current_setting('knowledge.owner_id', true), '') AS owner",
    )
    expect(clean.rows[0]?.pid).not.toBe(dirty.rows[0]?.pid)
    expect(clean.rows[0]?.owner).toBe(null)
  } finally {
    await pool.end()
  }
})

it('cannot commit after a swallowed PostgreSQL statement error', async () => {
  const { pool } = await openLocalDatabase('api')
  try {
    await expect(
      withKnowledgeTransaction(pool, principal(fixture.owners[0]), async (transaction) => {
        await transaction.query("UPDATE knowledge.kb_spaces SET title = 'Must roll back'")
        await transaction.query('SELECT 1 / 0').catch(() => {})
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const result = await withKnowledgeTransaction(
      pool,
      principal(fixture.owners[0]),
      (transaction) => transaction.query('SELECT title FROM knowledge.kb_spaces'),
    )
    expect(result.rows).toEqual([{ title: 'Synthetic space' }])
  } finally {
    await pool.end()
  }
})

it('rolls back real writes when the trusted principal expires before COMMIT', async () => {
  const { pool } = await openLocalDatabase('api')
  try {
    let now = Date.now()
    const identity = principal(fixture.owners[0], now)
    await expect(
      withKnowledgeTransaction(
        pool,
        identity,
        async (transaction) => {
          await transaction.query("UPDATE knowledge.kb_spaces SET title = 'Expired'")
          now += 60000
        },
        { now: () => now },
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    const result = await withKnowledgeTransaction(
      pool,
      principal(fixture.owners[0]),
      (transaction) => transaction.query('SELECT title FROM knowledge.kb_spaces'),
    )
    expect(result.rows).toEqual([{ title: 'Synthetic space' }])
  } finally {
    await pool.end()
  }
})

it('evicts a real backend after disconnection and admits a clean replacement', async () => {
  const { pool } = await openLocalDatabase('api')
  const { pool: admin } = await openLocalDatabase('bootstrap')
  try {
    const before = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await expect(
      withKnowledgeTransaction(pool, principal(fixture.owners[0]), async (transaction) => {
        await admin.query('SELECT pg_terminate_backend($1)', [before.rows[0]?.pid])
        await transaction.query('SELECT 1')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const after = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    expect(after.rows[0]?.pid).not.toBe(before.rows[0]?.pid)
  } finally {
    await pool.end()
    await admin.end()
  }
})

it('aborts on an actual row-lock timeout without leaving writes or a poisoned connection', async () => {
  const { pool } = await openLocalDatabase('api')
  const { pool: admin } = await openLocalDatabase('bootstrap')
  try {
    await admin.query('BEGIN')
    await admin.query('SELECT id FROM knowledge.kb_spaces WHERE owner_id = $1 FOR UPDATE', [
      fixture.owners[0],
    ])
    await expect(
      withKnowledgeTransaction(pool, principal(fixture.owners[0]), async (transaction) => {
        await transaction.query("SELECT set_config('lock_timeout', '50ms', true)")
        await transaction.query("UPDATE knowledge.kb_spaces SET title = 'Blocked'")
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await admin.query('ROLLBACK')
    const result = await withKnowledgeTransaction(
      pool,
      principal(fixture.owners[0]),
      (transaction) => transaction.query('SELECT title FROM knowledge.kb_spaces'),
    )
    expect(result.rows).toEqual([{ title: 'Synthetic space' }])
  } finally {
    await admin.query('ROLLBACK')
    await pool.end()
    await admin.end()
  }
})

it('never replays work after an injected lost reply to a genuinely committed transaction', async () => {
  const { pool } = await openLocalDatabase('api')
  let calls = 0
  const lostReplyPool: KnowledgeTransactionPool = {
    async connect() {
      const client = await pool.connect()
      return {
        async query(statement, values) {
          const result = await client.query(statement, values)
          // Fault injection loses only the reply: PostgreSQL has really committed the write.
          if (statement === 'COMMIT') throw new Error('synthetic lost commit reply')
          return result
        },
        release: (destroy) => client.release(destroy),
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
      }
    },
  }
  try {
    const before = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await expect(
      withKnowledgeTransaction(lostReplyPool, principal(fixture.owners[0]), async (transaction) => {
        calls += 1
        await transaction.query("UPDATE knowledge.kb_spaces SET title = 'Committed exactly once'")
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(calls).toBe(1)
    const after = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    expect(after.rows[0]?.pid).not.toBe(before.rows[0]?.pid)
    const result = await withKnowledgeTransaction(
      pool,
      principal(fixture.owners[0]),
      (transaction) => transaction.query('SELECT title FROM knowledge.kb_spaces'),
    )
    expect(result.rows).toEqual([{ title: 'Committed exactly once' }])
  } finally {
    await pool.end()
  }
})
