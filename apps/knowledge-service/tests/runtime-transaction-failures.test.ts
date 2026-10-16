import { expect, it, vi } from 'vitest'
import { withKnowledgeTransaction } from '../src/runtime'
import { KnowledgePolicyError } from '../src/errors'
import { now, principal, transactionFixture } from './runtime-transaction-fixtures'

it.each(['forged', 'expired', 'invalid-clock'] as const)(
  'refuses %s identities before acquiring a connection',
  async (kind) => {
    const { pool } = transactionFixture()
    const identity = kind === 'forged' ? { ...principal() } : principal()
    const clock = kind === 'expired' ? () => 2000 : kind === 'invalid-clock' ? () => NaN : now
    const work = vi.fn(async () => {})
    await expect(withKnowledgeTransaction(pool, identity, work, { now: clock })).rejects.toThrow(
      kind === 'invalid-clock' ? 'SERVICE_UNAVAILABLE' : 'UNAUTHENTICATED',
    )
    expect(pool.connect).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  },
)

it('sanitizes checkout failure without attempting release or work', async () => {
  const { pool, client } = transactionFixture()
  pool.connect.mockRejectedValue(new Error('private-password'))
  const work = vi.fn(async () => {})
  await expect(withKnowledgeTransaction(pool, principal(), work, { now })).rejects.toThrow(
    'SERVICE_UNAVAILABLE',
  )
  expect(work).not.toHaveBeenCalled()
  expect(client.release).not.toHaveBeenCalled()
})

it('rejects a principal that expires while waiting for checkout', async () => {
  const { pool, client } = transactionFixture()
  let clock = 1000
  pool.connect.mockImplementation(async () => {
    clock = 2000
    return client
  })
  await expect(
    withKnowledgeTransaction(pool, principal(), async () => {}, { now: () => clock }),
  ).rejects.toThrow('UNAUTHENTICATED')
  expect(client.query).not.toHaveBeenCalled()
  expect(client.release).toHaveBeenCalledWith(true)
})

it.each([
  [],
  [null],
  [{}],
  [{ owner_id: 'other-owner' }],
  [{ owner_id: '' }],
  [{ owner_id: null }, { owner_id: null }],
])('evicts dirty or unverified pooled identity rows %j', async (...rows) => {
  const { pool, client } = transactionFixture()
  client.query.mockResolvedValue({ rows, rowCount: rows.length })
  const work = vi.fn(async () => {})
  await expect(withKnowledgeTransaction(pool, principal(), work, { now })).rejects.toThrow(
    'SERVICE_UNAVAILABLE',
  )
  expect(work).not.toHaveBeenCalled()
  expect(client.query).toHaveBeenCalledOnce()
  expect(client.release).toHaveBeenCalledWith(true)
})

it.each(['probe', 'begin', 'binding', 'work', 'rollback'] as const)(
  'cleans up and sanitizes a %s failure',
  async (phase) => {
    const { pool, client } = transactionFixture()
    client.query.mockImplementation(async (statement) => {
      if (
        (phase === 'probe' && statement.includes('current_setting')) ||
        (phase === 'begin' && statement.startsWith('BEGIN')) ||
        (phase === 'binding' && statement.includes('set_config')) ||
        (phase === 'rollback' && statement === 'ROLLBACK')
      )
        throw new Error('private-dsn')
      return { rows: [{ owner_id: null }], rowCount: 1 }
    })
    const work = vi.fn(async () => {
      if (phase === 'work' || phase === 'rollback') throw new Error('private-payload')
    })
    await expect(withKnowledgeTransaction(pool, principal(), work, { now })).rejects.toThrow(
      'SERVICE_UNAVAILABLE',
    )
    const statements = client.query.mock.calls.map(([statement]) => statement)
    expect(statements).not.toContain('COMMIT')
    expect(statements.includes('ROLLBACK')).toBe(!['probe', 'begin'].includes(phase))
    expect(client.release.mock.calls).toEqual([[['probe', 'begin', 'rollback'].includes(phase)]])
  },
)

it('preserves policy failures and checks expiry before each query and commit', async () => {
  const { pool, client } = transactionFixture()
  let clock = 1000
  await expect(
    withKnowledgeTransaction(
      pool,
      principal(),
      async (transaction) => {
        clock = 2000
        await transaction.query('SELECT must_not_run')
      },
      { now: () => clock },
    ),
  ).rejects.toThrow('UNAUTHENTICATED')
  expect(client.query.mock.calls.map(([statement]) => statement)).not.toContain(
    'SELECT must_not_run',
  )
  clock = 1000
  await expect(
    withKnowledgeTransaction(
      pool,
      principal(),
      async () => {
        clock = 2000
      },
      { now: () => clock },
    ),
  ).rejects.toThrow('UNAUTHENTICATED')
  const failure = new KnowledgePolicyError('FORBIDDEN')
  await expect(
    withKnowledgeTransaction(
      pool,
      principal(),
      async () => {
        throw failure
      },
      { now },
    ),
  ).rejects.toBe(failure)
})

it('binds consecutive owners independently without a session-wide SET', async () => {
  const { pool, client } = transactionFixture()
  for (const owner of ['owner-A', 'owner-B']) {
    await withKnowledgeTransaction(pool, principal(owner), async () => {}, { now })
  }
  expect(client.query.mock.calls.filter(([statement]) => statement.includes('set_config'))).toEqual(
    [
      ["SELECT set_config('knowledge.owner_id', $1, true)", ['owner-A']],
      ["SELECT set_config('knowledge.owner_id', $1, true)", ['owner-B']],
    ],
  )
  expect(client.release.mock.calls).toEqual([[false], [false]])
})

it('handles checked-out client errors without uncaught events or returning the broken connection', async () => {
  const { pool, client, events } = transactionFixture()
  let listeners = 0
  let uncaught: unknown
  await expect(
    withKnowledgeTransaction(
      pool,
      principal(),
      async () => {
        listeners = events.listenerCount('error')
        try {
          events.emit('error', new Error('private-connection-diagnostic'))
        } catch (error) {
          uncaught = error
        }
      },
      { now },
    ),
  ).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(listeners).toBe(1)
  expect(uncaught).toBeUndefined()
  expect(events.listenerCount('error')).toBe(0)
  expect(client.release).toHaveBeenCalledWith(true)
  expect(client.query.mock.calls.map(([statement]) => statement)).not.toContain('COMMIT')
})

it.each(['binding', 'commit'] as const)(
  'fails closed for a connection error during %s',
  async (phase) => {
    const { pool, client, events } = transactionFixture()
    client.query.mockImplementation(async (statement) => {
      if (
        (phase === 'binding' && statement.includes('set_config')) ||
        (phase === 'commit' && statement === 'COMMIT')
      )
        events.emit('error', new Error('private-driver-error'))
      return { rows: [{ owner_id: null }], rowCount: 1 }
    })
    const work = vi.fn(async () => 'not a confirmed result')
    await expect(withKnowledgeTransaction(pool, principal(), work, { now })).rejects.toThrow(
      'SERVICE_UNAVAILABLE',
    )
    expect(work).toHaveBeenCalledTimes(phase === 'binding' ? 0 : 1)
    expect(client.release).toHaveBeenCalledWith(true)
    expect(events.listenerCount('error')).toBe(0)
  },
)
