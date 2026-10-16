import { readFile } from 'node:fs/promises'
import { afterAll, expect, it } from 'vitest'
import { PgBoss } from 'pg-boss'
import type { Job } from 'pg-boss'
import { createKnowledgePrincipal } from '../src/identity'
import { withKnowledgeTransaction } from '../src/runtime/transaction'
import { openLocalDatabase } from './local-database'

// B4 队列驱动验证：固定版本 pg-boss 12.37.1，直接架在已批准的本机隔离集群
// （tmp/knowledge-pg-isolated）的角色池上。适配器只承载 job 语句；队列存在性、
// 模式安装与授权边界由 maintenance 入口（apply-queue-local.mjs）先行负责。
// 这里验证同连接事务入队、认领/结算的 attempt 围栏行为，以及运行时角色的
// 授权面没有被放宽。

const QUEUE = 'b4_validate'

const pgBossVersion =
  (
    JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
  ).devDependencies['pg-boss'] ?? ''

type QueueDatabase = NonNullable<ConstructorParameters<typeof PgBoss>[0]>['db']

async function openQueueBoss(role: 'api' | 'worker') {
  const { pool } = await openLocalDatabase(role)
  const boss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (text, values) => pool.query(text, values) } as QueueDatabase,
    // 模式与授权由维护入口负责；实例绝不启动维护/调度/注册。
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  // 适配器路径上 error 事件没有处理器会让进程退出；测试里只收集不吞错。
  boss.on('error', () => {})
  return { pool, boss }
}

async function drain() {
  // 兜底清空可认领残留（例如上次运行中断留下的活动任务），避免跨测试串扰。
  // 认领面只在 worker：api 没有 UPDATE，本就不该能 fetch。
  const { pool, boss } = await openQueueBoss('worker')
  try {
    for (let i = 0; i < 100; i++) {
      const jobs = await boss.fetch(QUEUE)
      if (jobs.length === 0) return
      await boss.complete(QUEUE, jobs)
    }
    throw new Error('Queue did not drain')
  } finally {
    await pool.end()
  }
}

afterAll(async () => {
  // 池在每个用例内关闭；无全局资源。
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

it('pins the queue protocol to the reviewed pg-boss build', async () => {
  expect(pgBossVersion).toBe('12.37.1')
})

it('enqueues inside a knowledge transaction on the same connection and rolls back with it', async () => {
  const { pool } = await openLocalDatabase('api')
  try {
    const { rows: poolPid } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await expect(
      withKnowledgeTransaction(pool, principal('tx-owner'), async (transaction) => {
        const db = {
          executeSql: (text: string, values?: unknown[]) => transaction.query(text, values),
        } as QueueDatabase
        const txBoss = new PgBoss({ schema: 'pgboss', db, createSchema: false, migrate: false })
        txBoss.on('error', () => {})
        const id = await txBoss.send(QUEUE, { step: 'rollback' })
        expect(typeof id).toBe('string')
        // 入队与连接绑定检查共享同一条事务：pid 相同说明队列语句没有另开连接。
        // 非策略错误被 withKnowledgeTransaction 按设计统一映射为 SERVICE_UNAVAILABLE；
        // 回滚效果由下面的行数检查证实。
        const { rows } = await transaction.query(
          'SELECT pg_backend_pid() AS pid, name FROM pgboss.job_common WHERE id = $1',
          [id],
        )
        expect(rows).toEqual([{ pid: poolPid[0]?.pid, name: QUEUE }])
        throw new Error('synthetic rollback')
      }),
    ).rejects.toThrow('SERVICE_UNAVAILABLE')
    const { rows: after } = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM pgboss.job_common WHERE data->>'step' = 'rollback'",
    )
    expect(after[0]?.count).toBe('0')
  } finally {
    await pool.end()
  }
})

it('persists an enqueue committed with the knowledge transaction and settles it by attempt', async () => {
  const api = await openQueueBoss('api')
  try {
    await drain()
    const id = await withKnowledgeTransaction(api.pool, principal('tx-owner'), (transaction) => {
      const db = {
        executeSql: (text: string, values?: unknown[]) => transaction.query(text, values),
      } as QueueDatabase
      const txBoss = new PgBoss({ schema: 'pgboss', db, createSchema: false, migrate: false })
      txBoss.on('error', () => {})
      return txBoss.send(QUEUE, { step: 'commit' }) as Promise<string>
    })

    const worker = await openQueueBoss('worker')
    try {
      const jobs = await worker.boss.fetch(QUEUE)
      expect(jobs).toHaveLength(1)
      const job = jobs[0] as Job<{ step: string }>
      expect(job.id).toBe(id)
      expect(job.data).toEqual({ step: 'commit' })
      expect(job.retryCount).toBe(0)

      // attempt 围栏：错误尝试次数的心跳与结算都不会碰到这一认领。
      await expect(
        worker.boss.touch(QUEUE, [{ id: job.id, retryCount: 1 }]),
      ).resolves.toMatchObject({ affected: 0 })
      await expect(
        worker.boss.complete(QUEUE, [{ id: job.id, retryCount: 1 }], { done: true }),
      ).resolves.toMatchObject({ affected: 0 })

      await expect(
        worker.boss.touch(QUEUE, [{ id: job.id, retryCount: 0 }]),
      ).resolves.toMatchObject({ affected: 1 })
      await expect(
        worker.boss.complete(QUEUE, [{ id: job.id, retryCount: 0 }], { done: true }),
      ).resolves.toMatchObject({ affected: 1, requested: 1 })

      const { rows: settled } = await worker.pool.query<{
        state: string
        data: unknown
        output: unknown
      }>('SELECT state::text AS state, data, output FROM pgboss.job_common WHERE id = $1', [id])
      expect(settled[0]?.state).toBe('completed')
      // complete 的第三参是输出载荷（落 output 列），业务 data 保持入队时的原样。
      expect(settled[0]?.output).toEqual({ done: true })
      expect(settled[0]?.data).toEqual({ step: 'commit' })
    } finally {
      await worker.pool.end()
    }
  } finally {
    await api.pool.end()
  }
})

it('retries a failed attempt and fences stale settles until the attempt is terminal', async () => {
  const api = await openQueueBoss('api')
  try {
    await drain()
    const id = (await api.boss.send(
      QUEUE,
      { step: 'retry' },
      {
        retryLimit: 1,
        retryDelay: 0,
      },
    )) as string

    const worker = await openQueueBoss('worker')
    try {
      const first = (await worker.boss.fetch(QUEUE))[0] as Job
      expect(first.id).toBe(id)
      expect(first.retryCount).toBe(0)
      await expect(
        worker.boss.fail(QUEUE, [{ id: first.id, retryCount: 1 }], { error: 'fenced' }),
      ).resolves.toMatchObject({ affected: 0 })
      await expect(
        worker.boss.fail(QUEUE, [{ id: first.id, retryCount: 0 }], { error: 'first failure' }),
      ).resolves.toMatchObject({ affected: 1 })

      // 重试行以新的 attempt 认领：retryCount 前进到 1，旧结算仍然无效。
      const second = (await worker.boss.fetch(QUEUE))[0] as Job
      expect(second.id).toBe(id)
      expect(second.retryCount).toBe(1)
      await expect(
        worker.boss.complete(QUEUE, [{ id: second.id, retryCount: 0 }]),
      ).resolves.toMatchObject({ affected: 0 })
      await expect(
        worker.boss.fail(QUEUE, [{ id: second.id, retryCount: 1 }], { error: 'terminal' }),
      ).resolves.toMatchObject({ affected: 1 })

      const { rows: terminal } = await worker.pool.query<{ state: string; output: unknown }>(
        'SELECT state::text AS state, output FROM pgboss.job_common WHERE id = $1',
        [id],
      )
      expect(terminal[0]?.state).toBe('failed')
      expect(terminal[0]?.output).toEqual({ error: 'terminal' })
      await expect(worker.boss.fetch(QUEUE)).resolves.toEqual([])
    } finally {
      await worker.pool.end()
    }
  } finally {
    await api.pool.end()
  }
})

it('exhausts retryLimit 0 into a terminal failed job without retry rows', async () => {
  const api = await openQueueBoss('api')
  try {
    await drain()
    const id = (await api.boss.send(QUEUE, { step: 'exhaust' }, { retryLimit: 0 })) as string
    const worker = await openQueueBoss('worker')
    try {
      const job = (await worker.boss.fetch(QUEUE))[0] as Job
      expect(job.retryCount).toBe(0)
      await expect(
        worker.boss.fail(QUEUE, [{ id: job.id, retryCount: 0 }], { error: 'no retry budget' }),
      ).resolves.toMatchObject({ affected: 1 })
      const { rows: terminal } = await worker.pool.query<{ retry_count: number; state: string }>(
        'SELECT retry_count, state::text AS state FROM pgboss.job_common WHERE id = $1',
        [id],
      )
      expect(terminal[0]).toEqual({ retry_count: 0, state: 'failed' })
    } finally {
      await worker.pool.end()
    }
  } finally {
    await api.pool.end()
  }
})

it('auto-settles handler outcomes through work() without starting maintenance', async () => {
  const api = await openQueueBoss('api')
  const worker = await openQueueBoss('worker')
  try {
    await drain()
    const handled = new Promise<Job>((resolve) => {
      worker.boss.work(
        QUEUE,
        { pollingIntervalSeconds: 1 },
        async (jobs: Job<{ step: string }>[]) => {
          // work() 的 handler 恒收批次（manager.js:655 callback(jobs)），默认批量为 1。
          resolve(jobs[0])
          return { accepted: true }
        },
      )
    })
    const id = (await api.boss.send(QUEUE, { step: 'work' })) as string
    const job = await Promise.race([
      handled,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('work() never picked up the job')), 15000),
      ),
    ])
    expect(job.id).toBe(id)
    expect(job.data).toEqual({ step: 'work' })
    await worker.boss.offWork(QUEUE)

    // 处理器抛错被 work() 自己吞掉并自动 fail（不 reject work() 本身），
    // 因此这里只观察终态：预算 0 时失败处理器不该要求手动 fail()，直接终态。
    worker.boss
      .work(QUEUE, { pollingIntervalSeconds: 1 }, async () => {
        throw new Error('synthetic handler failure')
      })
      .catch(() => {})
    const failingId = (await api.boss.send(
      QUEUE,
      { step: 'work-fail' },
      {
        retryLimit: 0,
      },
    )) as string
    await expect
      .poll(
        async () => {
          const { rows: picked } = await worker.pool.query<{ state: string }>(
            'SELECT state::text AS state FROM pgboss.job_common WHERE id = $1',
            [failingId],
          )
          return picked[0]?.state
        },
        { timeout: 10000, interval: 500 },
      )
      .toBe('failed')
    await worker.boss.offWork(QUEUE)
  } finally {
    await worker.boss.offWork(QUEUE).catch(() => {})
    await worker.pool.end()
    await api.pool.end()
  }
})

it('keeps runtime roles on the reviewed statement surface and maintenance ownership intact', async () => {
  for (const role of ['api', 'worker'] as const) {
    const { pool } = await openLocalDatabase(role)
    try {
      const { rows } = await pool.query<{
        name: string
        sel: boolean
        ins: boolean
        upd: boolean
        del: boolean
      }>(
        `SELECT tablename::text AS name,
          has_table_privilege(current_user, 'pgboss.' || tablename, 'SELECT') AS sel,
          has_table_privilege(current_user, 'pgboss.' || tablename, 'INSERT') AS ins,
          has_table_privilege(current_user, 'pgboss.' || tablename, 'UPDATE') AS upd,
          has_table_privilege(current_user, 'pgboss.' || tablename, 'DELETE') AS del
         FROM pg_tables WHERE schemaname = 'pgboss' ORDER BY tablename`,
      )
      // v12.37 运行时语句直达非分区队列的具体存储表 job_common（queue.table_name）；
      // 唯一例外是 fail() 的死信 CTE 恒引用分区父表 job（plans.js:3009），
      // 因此 worker 对父表只有 INSERT，两个角色都没有对它的 SELECT/UPDATE/DELETE。
      const writeSurface = new Set(
        rows.filter((row) => row.ins || row.upd || row.del).map((row) => row.name),
      )
      expect(writeSurface).toEqual(
        new Set(role === 'worker' ? ['job', 'job_common'] : ['job_common']),
      )
      expect(rows.filter((row) => row.sel).map((row) => row.name)).toEqual(['job_common', 'queue'])
      // fail() 的重试 CTE 需要对 job_common 的 DELETE；仅 worker 需要。
      const common = rows.find((row) => row.name === 'job_common')
      expect(common?.del).toBe(role === 'worker')
      expect(common?.upd).toBe(role === 'worker')
      const parent = rows.find((row) => row.name === 'job')
      expect(parent?.ins).toBe(role === 'worker')
      expect(parent?.sel || parent?.upd || parent?.del).toBe(false)
      const { rows: owners } = await pool.query<{ owner: string }>(
        `SELECT DISTINCT tableowner::text AS owner FROM pg_tables WHERE schemaname = 'pgboss' ORDER BY 1`,
      )
      expect(owners).toEqual([{ owner: 'knowledge_migrator' }])
    } finally {
      await pool.end()
    }
  }

  // 功能级证据：api 没有认领/结算用的 UPDATE，fetch 必须以 42501 失败。
  const api = await openQueueBoss('api')
  try {
    await expect(api.boss.fetch(QUEUE)).rejects.toMatchObject({ code: '42501' })
  } finally {
    await api.pool.end()
  }
})
