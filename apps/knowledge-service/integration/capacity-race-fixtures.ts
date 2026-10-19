import type { Pool, PoolClient } from 'pg'
import { type CapacityFixture, withCapacityFixture } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'

export async function withCapacityRace(
  work: (context: {
    fixture: CapacityFixture
    writer: PoolClient
    waiter: PoolClient
    observer: PoolClient
    writerPid: number
    waiterPid: number
  }) => Promise<void>,
) {
  await withCapacityFixture(async (fixture) => {
    const pools: Pool[] = []
    const clients: PoolClient[] = []
    try {
      for (const role of ['api', 'api', 'bootstrap'] as const) {
        const { pool } = await openLocalDatabase(role)
        pools.push(pool)
        clients.push(await pool.connect())
      }
      const [writer, waiter, observer] = clients
      if (!writer || !waiter || !observer) throw new Error('Missing real capacity sessions')
      for (const client of [writer, waiter]) {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await client.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
        await client.query("SET LOCAL lock_timeout = '3s'")
      }
      const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid
      const waiterPid = (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid
      await work({ fixture, writer, waiter, observer, writerPid, waiterPid })
    } finally {
      // 两侧一起回滚，避免清理排在另一连接尚未解除的锁等待之后。
      await Promise.allSettled(clients.slice(0, 2).map((client) => client.query('ROLLBACK')))
      for (const client of clients) client.release()
      await Promise.all(pools.map((pool) => pool.end()))
    }
  })
}
