import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PgBoss } from 'pg-boss'
import { createKnowledgePrincipal } from '../src/identity'
import { createKnowledgeQueue } from '../src/runtime/queue'
import { startKnowledgeQueueConsumer } from '../src/runtime/queue-consumer'
import { withKnowledgeTransaction } from '../src/runtime/transaction'
import { parseKnowledgeRuntimeConfig, startKnowledgeWorker } from '../src/runtime'
import { openLocalDatabase } from './local-database'

const name = `runtime_${randomUUID().replaceAll('-', '')}`
const ownerId = `synthetic-${randomUUID()}`
const envelope = {
  ownerId,
  operationId: randomUUID(),
  buildId: randomUUID(),
  receiptId: randomUUID(),
}
let api: Awaited<ReturnType<typeof openLocalDatabase>>
let worker: Awaited<ReturnType<typeof openLocalDatabase>>
let maintenance: Awaited<ReturnType<typeof openLocalDatabase>>
let administrator: PgBoss

beforeAll(async () => {
  api = await openLocalDatabase('api')
  worker = await openLocalDatabase('worker')
  maintenance = await openLocalDatabase('migrator')
  administrator = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (statement, values) => maintenance.pool.query(statement, values) },
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  administrator.on('error', () => {})
  await administrator.createQueue(name, { retryLimit: 1, retryDelay: 0 })
})

afterAll(async () => {
  try {
    await administrator?.deleteQueue(name)
  } finally {
    await Promise.all([api?.pool.end(), worker?.pool.end(), maintenance?.pool.end()])
  }
})

function principal() {
  const now = Date.now()
  return createKnowledgePrincipal(
    {
      issuer: 'https://synthetic.invalid',
      audiences: ['local-knowledge'],
      subject: ownerId,
      expiresAt: now + 60000,
      permissions: [],
    },
    { issuer: 'https://synthetic.invalid', audience: 'local-knowledge' },
    now,
  )
}

it('enqueues on the caller transaction and completes a real claimed attempt', async () => {
  let rolledBackId: string | undefined
  await expect(
    withKnowledgeTransaction(api.pool, principal(), async (transaction) => {
      rolledBackId = await createKnowledgeQueue(transaction, name).enqueue(envelope)
      throw new Error('synthetic rollback')
    }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(
    (await worker.pool.query('SELECT id FROM pgboss.job_common WHERE id = $1', [rolledBackId]))
      .rows,
  ).toEqual([])
  const id = await withKnowledgeTransaction(api.pool, principal(), (transaction) =>
    createKnowledgeQueue(transaction, name).enqueue(envelope),
  )
  const queue = createKnowledgeQueue(worker.pool, name)
  const job = await queue.fetch()
  expect(job).toMatchObject({ id, retryCount: 0, data: envelope })
  if (!job) throw new Error('Expected claimed job')
  await queue.heartbeat(job)
  await queue.complete(job)
  expect(
    (
      await worker.pool.query('SELECT state::text AS state FROM pgboss.job_common WHERE id = $1', [
        id,
      ])
    ).rows,
  ).toEqual([{ state: 'completed' }])
})

it('refuses stale heartbeat and settlement after a retry is claimed', async () => {
  const id = await createKnowledgeQueue(api.pool, name).enqueue(envelope)
  const queue = createKnowledgeQueue(worker.pool, name)
  const first = await queue.fetch()
  if (!first) throw new Error('Expected first attempt')
  await queue.fail(first, 'SERVICE_UNAVAILABLE')
  const second = await queue.fetch()
  expect(second).toMatchObject({ id, retryCount: 1 })
  if (!second) throw new Error('Expected retry attempt')
  await expect(queue.heartbeat(first)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  await expect(queue.complete(first)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  await queue.complete(second)
})

it('rolls queue settlement back with later knowledge-transaction failure', async () => {
  const id = await createKnowledgeQueue(api.pool, name).enqueue(envelope)
  const queue = createKnowledgeQueue(worker.pool, name)
  const job = await queue.fetch()
  if (!job) throw new Error('Expected claimed job')
  await expect(
    withKnowledgeTransaction(worker.pool, principal(), async (transaction) => {
      await createKnowledgeQueue(transaction, name).complete(job)
      throw new Error('synthetic publication failure')
    }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(
    (
      await worker.pool.query('SELECT state::text AS state FROM pgboss.job_common WHERE id = $1', [
        id,
      ])
    ).rows,
  ).toEqual([{ state: 'active' }])
  await queue.complete(job)
})

it('consumes and settles a real job through the running queue consumer', async () => {
  const id = await createKnowledgeQueue(api.pool, name).enqueue(envelope)
  const seen: unknown[] = []
  const consumer = startKnowledgeQueueConsumer(
    createKnowledgeQueue(worker.pool, name),
    async (context) => {
      seen.push(context.envelope)
    },
    { pollIntervalMs: 20 },
  )
  try {
    await expect
      .poll(
        async () =>
          (
            await worker.pool.query(
              'SELECT state::text AS state FROM pgboss.job_common WHERE id = $1',
              [id],
            )
          ).rows[0]?.state,
        { timeout: 3000, interval: 20 },
      )
      .toBe('completed')
    expect(seen).toEqual([envelope])
  } finally {
    await consumer.close()
  }
  expect(await consumer.finished).toEqual({ code: 'STOPPED' })
})

it('aborts a handler after losing its attempt without settling the replacement', async () => {
  const queue = createKnowledgeQueue(worker.pool, name)
  const id = await createKnowledgeQueue(api.pool, name).enqueue(envelope)
  const stop = new AbortController()
  let started!: (job: { id: string; retryCount: number }) => void
  const claimed = new Promise<{ id: string; retryCount: number }>((resolve) => {
    started = resolve
  })
  const consumer = startKnowledgeQueueConsumer(
    queue,
    async (context) => {
      started(context.job)
      await new Promise<void>((resolve) => {
        context.signal.addEventListener(
          'abort',
          () => {
            stop.abort()
            resolve()
          },
          { once: true },
        )
      })
    },
    { signal: stop.signal, heartbeatIntervalMs: 10 },
  )
  try {
    await queue.fail(await claimed, 'SERVICE_UNAVAILABLE')
    expect(await consumer.finished).toEqual({ code: 'STOPPED' })
    expect(
      (
        await worker.pool.query(
          'SELECT state::text AS state, retry_count FROM pgboss.job_common WHERE id = $1',
          [id],
        )
      ).rows,
    ).toEqual([{ state: 'retry', retry_count: 0 }])
  } finally {
    await consumer.close()
  }
  const retry = await queue.fetch()
  if (!retry) throw new Error('Expected replacement attempt')
  expect(retry.retryCount).toBe(1)
  await queue.complete(retry)
})

it('runs the consumer inside the worker service and drains it on shutdown', async () => {
  const id = await createKnowledgeQueue(api.pool, name).enqueue(envelope)
  const serviceDatabase = await openLocalDatabase('worker')
  const { settings } = serviceDatabase
  const config = parseKnowledgeRuntimeConfig(
    {
      KNOWLEDGE_ENVIRONMENT: 'isolated_test',
      KNOWLEDGE_DATABASE_NAME: settings.database,
      KNOWLEDGE_WORKER_DATABASE_ROLE: settings.roles.worker.user,
      KNOWLEDGE_WORKER_DATABASE_URL: `postgresql://${settings.roles.worker.user}:${settings.roles.worker.password}@127.0.0.1:55432/${settings.database}`,
    },
    'worker',
  )
  if (config.role !== 'worker') throw new Error('Expected worker configuration')
  const seen: unknown[] = []
  const service = await startKnowledgeWorker(config, {
    poolFactory: () => serviceDatabase.pool,
    queue: {
      name,
      handle: async (context) => {
        seen.push(context.envelope)
      },
      pollIntervalMs: 20,
    },
  })
  try {
    await expect
      .poll(
        async () =>
          (
            await worker.pool.query(
              'SELECT state::text AS state FROM pgboss.job_common WHERE id = $1',
              [id],
            )
          ).rows[0]?.state,
        { timeout: 3000, interval: 20 },
      )
      .toBe('completed')
    expect(seen).toEqual([envelope])
  } finally {
    await service.close()
  }
  expect(await service.finished).toEqual({ code: 'STOPPED' })
})

it('accepts a handler completing its attempt in a transaction without failing or settling it again', async () => {
  const queue = createKnowledgeQueue(worker.pool, name)
  const id = await createKnowledgeQueue(api.pool, name).enqueue(envelope)
  const seen: string[] = []
  const consumer = startKnowledgeQueueConsumer(
    queue,
    async ({ job }) => {
      await withKnowledgeTransaction(worker.pool, principal(), (transaction) =>
        createKnowledgeQueue(transaction, name).complete(job),
      )
      seen.push(job.id)
    },
    { pollIntervalMs: 20 },
  )
  try {
    await expect
      .poll(
        async () =>
          (
            await worker.pool.query(
              'SELECT state::text AS state FROM pgboss.job_common WHERE id = $1',
              [id],
            )
          ).rows[0]?.state,
        { timeout: 3000, interval: 20 },
      )
      .toBe('completed')
    expect(seen).toEqual([id])
  } finally {
    await consumer.close()
  }
  expect(await consumer.finished).toEqual({ code: 'STOPPED' })
})
