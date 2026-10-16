import type { Pool, PoolClient } from 'pg'
import { expect, vi } from 'vitest'
import type { BuildFixture } from './build-fixtures'
import { openLocalDatabase } from './local-database'
import { removeTenants, seedTenants } from './tenant-fixtures'

export async function withBuildRace(
  work: (context: {
    fixture: BuildFixture
    writer: PoolClient
    closer: PoolClient
    observer: PoolClient
    writerPid: number
    closerPid: number
  }) => Promise<void>,
) {
  const fixture = await seedTenants('build-race')
  const pools: Pool[] = []
  const clients: PoolClient[] = []
  try {
    for (const role of ['migrator', 'migrator', 'bootstrap'] as const) {
      const { pool } = await openLocalDatabase(role)
      pools.push(pool)
      clients.push(await pool.connect())
    }
    const [writer, closer, observer] = clients
    if (!writer || !closer || !observer) throw new Error('Missing real build sessions')
    for (const client of [writer, closer]) {
      await client.query('BEGIN')
      await client.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
      await client.query("SET LOCAL lock_timeout = '3s'")
    }
    const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid
    const closerPid = (await closer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid
    await work({ fixture, writer, closer, observer, writerPid, closerPid })
  } finally {
    // Roll both sides back concurrently so a queued rollback cannot remain behind a blocked statement.
    await Promise.allSettled(clients.slice(0, 2).map((client) => client.query('ROLLBACK')))
    for (const client of clients) client.release()
    await Promise.all(pools.map((pool) => pool.end()))
    await removeTenants(fixture)
  }
}

export async function expectBlocked(observer: PoolClient, waitingPid: number, blockingPid: number) {
  await vi.waitFor(
    async () => {
      const result = await observer.query<{ blocked: boolean }>(
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
        [waitingPid, blockingPid],
      )
      expect(result.rows).toEqual([{ blocked: true }])
    },
    { timeout: 1500, interval: 10 },
  )
}
