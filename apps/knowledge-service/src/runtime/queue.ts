import { PgBoss, type Job } from 'pg-boss'
import type { KnowledgeErrorCode } from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import { parseQueueEnvelope, type QueueEnvelope, type QueueJobRef } from './queue-envelope'

export type KnowledgeQueueJob = Job<unknown>

function requireAffectedAttempt(response: unknown) {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('requested' in response) ||
    response.requested !== 1 ||
    !('affected' in response) ||
    typeof response.affected !== 'number'
  )
    deny('SERVICE_UNAVAILABLE')
  if (response.affected !== 1) deny('VERSION_CONFLICT')
}

export function createKnowledgeQueue(
  database: {
    query: (statement: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
  },
  name: string,
) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) deny('NOT_CONFIGURED')
  const boss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (statement, values) => database.query(statement, values) },
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  // 只使用手动队列语句，不启动instance注册、DDL、维护或自动结算。
  boss.on('error', () => {})
  return {
    async enqueue(envelope: QueueEnvelope) {
      const id = await boss.send(name, parseQueueEnvelope(envelope))
      if (id === null) deny('VERSION_CONFLICT')
      return id
    },
    async fetch() {
      const jobs = await boss.fetch<unknown>(name, { batchSize: 1 })
      return jobs.at(0) ?? null
    },
    async heartbeat(job: QueueJobRef) {
      requireAffectedAttempt(await boss.touch(name, [{ id: job.id, retryCount: job.retryCount }]))
    },
    async complete(job: QueueJobRef) {
      requireAffectedAttempt(
        await boss.complete(name, [{ id: job.id, retryCount: job.retryCount }]),
      )
    },
    async fail(job: QueueJobRef, code: KnowledgeErrorCode) {
      requireAffectedAttempt(
        await boss.fail(name, [{ id: job.id, retryCount: job.retryCount }], { code }),
      )
    },
  }
}

export type KnowledgeQueue = ReturnType<typeof createKnowledgeQueue>
