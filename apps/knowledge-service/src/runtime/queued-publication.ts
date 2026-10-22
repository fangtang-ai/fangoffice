import { deny } from '../errors'
import { publishBuild } from './build-lifecycle'
import { createKnowledgeQueue } from './queue'
import { parseQueueEnvelope, type QueueEnvelope, type QueueJobRef } from './queue-envelope'
import type { KnowledgeTransaction } from './transaction'

export async function publishQueuedBuild(
  transaction: KnowledgeTransaction,
  queueName: string,
  job: QueueJobRef,
  input: QueueEnvelope,
) {
  const envelope = parseQueueEnvelope(input)
  const queue = createKnowledgeQueue(transaction, queueName)
  const { rows } = await transaction.query(
    `SELECT build.document_id::text AS document_id, build.version_id::text AS version_id,
            build.index_profile_id::text AS index_profile_id
       FROM knowledge.kb_builds build
       JOIN knowledge.kb_operations operation
         ON operation.owner_id = build.owner_id AND operation.id = build.operation_id
      WHERE build.owner_id = $1 AND build.id = $2 AND build.operation_id = $3
        AND build.job_id = $4 AND build.retry_count = $5
        AND operation.current_build_id = build.id
        AND operation.current_job_id = build.job_id
        AND operation.current_retry_count = build.retry_count
        AND operation.current_receipt_id = $6`,
    [
      envelope.ownerId,
      envelope.buildId,
      envelope.operationId,
      job.id,
      job.retryCount,
      envelope.receiptId,
    ],
  )
  const build = rows[0] as
    { document_id: string; version_id: string; index_profile_id: string } | undefined
  if (!build) deny('NOT_FOUND')
  const locked = await transaction.query(
    'SELECT knowledge.lock_build_lifecycle($1, $2, $3, $4) AS status',
    [envelope.ownerId, build.document_id, envelope.operationId, envelope.buildId],
  )
  const status = (locked.rows[0] as { status?: unknown } | undefined)?.status
  if (status !== 'LOCKED') {
    if (status === 'NOT_FOUND' || status === 'UNAUTHENTICATED') deny(status)
    deny('FORBIDDEN')
  }
  // 先取知识父锁，再锁固定12.37.1且已授权的共享job_common；失败必须传播给事务整体回滚。
  await transaction.query(
    'SELECT id FROM pgboss.job_common WHERE name = $1 AND id = $2 FOR UPDATE',
    [queueName, job.id],
  )
  // 先取行锁再读实际时钟，避免锁等待后仍沿用旧快照或事务开始时刻判断租约。
  const live = await transaction.query(
    `SELECT data FROM pgboss.job_common
      WHERE name = $1 AND id = $2 AND retry_count = $3 AND state = 'active'
        AND started_on + expire_seconds * interval '1s' > clock_timestamp()
        AND (heartbeat_seconds IS NULL
          OR heartbeat_on + heartbeat_seconds * interval '1s' > clock_timestamp())`,
    [queueName, job.id, job.retryCount],
  )
  const active = live.rows[0] as { data: unknown } | undefined
  if (!active) deny('VERSION_CONFLICT')
  const stored = parseQueueEnvelope(active.data)
  if (
    stored.ownerId !== envelope.ownerId ||
    (['operationId', 'buildId', 'receiptId'] as const).some(
      (key) => stored[key].toLowerCase() !== envelope[key].toLowerCase(),
    )
  )
    deny('VERSION_CONFLICT')
  await queue.complete(job)
  return publishBuild(transaction, {
    ownerId: envelope.ownerId,
    documentId: build.document_id,
    operationId: envelope.operationId,
    versionId: build.version_id,
    buildId: envelope.buildId,
    indexProfileId: build.index_profile_id,
  })
}
