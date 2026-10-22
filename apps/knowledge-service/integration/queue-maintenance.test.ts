import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PgBoss } from 'pg-boss'
import { expect, it, vi } from 'vitest'
import * as runtime from '../src/runtime'
import { openLocalDatabase, serviceDirectory, type LocalRole } from './local-database'
import { expectBlocked } from './build-race-fixtures'

async function maintenanceFixture() {
  const maintenance = await openLocalDatabase('migrator')
  const worker = await openLocalDatabase('worker')
  const boss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (sql, values) => maintenance.pool.query(sql, values) },
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  boss.on('error', () => {})
  const names = [
    `maint_${randomUUID().replaceAll('-', '')}`,
    `other_${randomUUID().replaceAll('-', '')}`,
  ]
  await Promise.all(
    names.map((name) =>
      boss.createQueue(name, {
        expireInSeconds: 2,
        heartbeatSeconds: 10,
        retryLimit: 1,
        retryDelay: 0,
      }),
    ),
  )
  return {
    maintenance,
    worker,
    boss,
    name: names[0]!,
    otherName: names[1]!,
    async run(role: LocalRole = 'migrator') {
      const executor = await openLocalDatabase(role)
      const { settings } = executor
      const config = runtime.parseKnowledgeMaintenanceConfig({
        KNOWLEDGE_ENVIRONMENT: 'isolated_test',
        KNOWLEDGE_DATABASE_NAME: settings.database,
        KNOWLEDGE_MAINTENANCE_DATABASE_ROLE: settings.roles[role].user,
        KNOWLEDGE_MAINTENANCE_DATABASE_URL: `postgresql://${settings.roles[role].user}:${settings.roles[role].password}@127.0.0.1:55432/${settings.database}`,
        KNOWLEDGE_QUEUE_NAME: names[0],
      })
      const statements: string[] = []
      await runtime.maintainKnowledgeQueue(config, {
        poolFactory: () => ({
          query: async (sql, values) => {
            statements.push(sql)
            return executor.pool.query(sql, values)
          },
          connect: () => executor.pool.connect(),
          end: () => executor.pool.end(),
          on: (event, listener) => executor.pool.on(event, listener),
        }),
      })
      return statements
    },
    async close() {
      try {
        await Promise.all(names.map((name) => boss.deleteQueue(name)))
      } finally {
        await Promise.all([maintenance.pool.end(), worker.pool.end()])
      }
    },
  }
}

it.each(['timeout', 'heartbeat'] as const)(
  'recovers a %s-expired attempt only on the explicitly selected queue without DDL',
  async (kind) => {
    const fixture = await maintenanceFixture()
    try {
      const envelope = {
        ownerId: 'synthetic-owner',
        operationId: randomUUID(),
        buildId: randomUUID(),
        receiptId: randomUUID(),
      }
      const queue = runtime.createKnowledgeQueue(fixture.worker.pool, fixture.name)
      const other = runtime.createKnowledgeQueue(fixture.worker.pool, fixture.otherName)
      const id = await queue.enqueue(envelope)
      const otherId = await other.enqueue(envelope)
      const attempt = await queue.fetch()
      expect(attempt?.id).toBe(id)
      await other.fetch()
      // 仅回拨本测试合成任务的时间，模拟进程已退出；到期判断仍由真实维护SQL执行。
      await fixture.maintenance.pool.query(
        `UPDATE pgboss.job_common SET
      started_on = pgboss.job_now() - ($3::int * interval '1 second'),
      heartbeat_on = pgboss.job_now() - interval '20 seconds' WHERE id IN ($1, $2)`,
        [id, otherId, kind === 'timeout' ? 20 : 0],
      )
      const statements = await fixture.run()
      expect(statements.join('\n')).not.toMatch(/\b(?:CREATE|ALTER|DROP|REINDEX|TRUNCATE)\s/i)
      expect(
        (
          await fixture.worker.pool.query(
            'SELECT state::text AS state FROM pgboss.job_common WHERE id=$1',
            [otherId],
          )
        ).rows,
      ).toEqual([{ state: 'active' }])
      const retry = await queue.fetch()
      expect(retry).toMatchObject({ id, retryCount: 1 })
      if (!attempt || !retry) throw new Error('Expected claimed attempts')
      await expect(queue.heartbeat(attempt)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      await expect(queue.complete(attempt)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      await queue.complete(retry)
    } finally {
      await fixture.close()
    }
  },
)

it.each(['api', 'worker'] as const)(
  'rejects queue maintenance under the %s role without granting new privileges',
  async (role) => {
    const fixture = await maintenanceFixture()
    try {
      await expect(fixture.run(role)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    } finally {
      await fixture.close()
    }
  },
)

it('refuses a real heartbeat queued behind completion instead of renewing a completed attempt', async () => {
  const fixture = await maintenanceFixture()
  const closer = await openLocalDatabase('worker')
  const observer = await openLocalDatabase('bootstrap')
  const lock = await fixture.maintenance.pool.connect()
  const results: Promise<unknown>[] = []
  try {
    const queue = runtime.createKnowledgeQueue(fixture.worker.pool, fixture.name)
    await queue.enqueue({
      ownerId: 'synthetic-owner',
      operationId: randomUUID(),
      buildId: randomUUID(),
      receiptId: randomUUID(),
    })
    const attempt = await queue.fetch()
    if (!attempt) throw new Error('Expected claimed attempt')
    const closerPid = (await closer.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid
    const heartbeatPid = (
      await fixture.worker.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0]!.pid
    await lock.query('BEGIN')
    const lockPid = (await lock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid
    await lock.query('SELECT id FROM pgboss.job_common WHERE id=$1 FOR UPDATE', [attempt.id])
    const completion = runtime
      .createKnowledgeQueue(closer.pool, fixture.name)
      .complete(attempt)
      .then(
        () => 'completed',
        () => 'failed',
      )
    results.push(completion)
    const observation = await observer.pool.connect()
    try {
      await expectBlocked(observation, closerPid, lockPid)
      const heartbeat = queue.heartbeat(attempt).then(
        () => 'renewed',
        (error: unknown) => error,
      )
      results.push(heartbeat)
      await vi.waitFor(
        async () => {
          const blocked = await observation.query<{ blocked: boolean }>(
            'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
            [heartbeatPid],
          )
          expect(blocked.rows).toEqual([{ blocked: true }])
        },
        { timeout: 500, interval: 10 },
      )
      await lock.query('COMMIT')
      expect(await completion).toBe('completed')
      expect(await heartbeat).toMatchObject({ code: 'VERSION_CONFLICT' })
    } finally {
      observation.release()
    }
  } finally {
    await lock.query('ROLLBACK')
    lock.release()
    await Promise.allSettled(results)
    await Promise.all([closer.pool.end(), observer.pool.end(), fixture.close()])
  }
})

it('executes the built one-shot maintenance command with separate role configuration and exits cleanly', async () => {
  const fixture = await maintenanceFixture()
  try {
    const execute = promisify(execFile)
    await execute(process.execPath, ['scripts/build.mjs'], {
      cwd: serviceDirectory,
      windowsHide: true,
      timeout: 15000,
    })
    const { settings } = fixture.maintenance
    const env = {
      ...process.env,
      KNOWLEDGE_ENVIRONMENT: 'isolated_test',
      KNOWLEDGE_DATABASE_NAME: settings.database,
      KNOWLEDGE_MAINTENANCE_DATABASE_ROLE: settings.roles.migrator.user,
      KNOWLEDGE_MAINTENANCE_DATABASE_URL: `postgresql://${settings.roles.migrator.user}:${settings.roles.migrator.password}@127.0.0.1:55432/${settings.database}`,
      KNOWLEDGE_QUEUE_NAME: fixture.name,
    }
    await expect(
      execute(process.execPath, ['dist/maintenance.mjs'], {
        cwd: serviceDirectory,
        env,
        windowsHide: true,
        timeout: 10000,
      }),
    ).resolves.toMatchObject({ stdout: 'knowledge-maintenance complete\n', stderr: '' })
  } finally {
    await fixture.close()
  }
})
