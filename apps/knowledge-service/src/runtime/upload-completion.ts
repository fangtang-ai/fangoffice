import { randomUUID } from 'node:crypto'
import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'
import { createKnowledgeQueue } from './queue'
import type { QueueEnvelope } from './queue-envelope'
import { uploadCommand } from './upload-command'
import {
  completionInput,
  type KnowledgeUploadCompletion,
  type KnowledgeUploadCompletionPolicy,
} from './upload-completion-input'

export type {
  KnowledgeUploadCompletion,
  KnowledgeUploadCompletionPolicy,
} from './upload-completion-input'

export async function completeKnowledgeUpload(
  transaction: KnowledgeTransaction,
  input: KnowledgeUploadCompletion,
  policy: KnowledgeUploadCompletionPolicy,
) {
  const { operation, stored, bucket, queueName, maximumFileBytes, capacity } = completionInput(
    input,
    policy,
  )
  const target = [
    operation.spaceId,
    operation.documentId,
    operation.id,
    operation.expectedGeneration,
  ]
  await uploadCommand(
    transaction,
    'SELECT knowledge.lock_upload_completion($1,$2,$3,$4) AS status',
    target,
  )
  const context = await transaction.query(
    'SELECT owner_id,phase FROM knowledge.kb_operations WHERE id=$1 AND document_id=$2',
    [operation.id, operation.documentId],
  )
  const row = context.rows[0] as { owner_id: string; phase: string } | undefined
  if (context.rows.length !== 1 || !row || typeof row.owner_id !== 'string')
    deny('SERVICE_UNAVAILABLE')
  // 领域拒绝不一定中止外层事务；局部回滚避免调用者捕获错误后提交孤儿任务。
  await transaction.query('SAVEPOINT knowledge_upload_completion')
  try {
    let jobId: string | null = null
    let envelope: QueueEnvelope | null = null
    if (row.phase === 'uploading') {
      envelope = {
        ownerId: row.owner_id,
        operationId: operation.id,
        buildId: randomUUID(),
        receiptId: randomUUID(),
      }
      jobId = await createKnowledgeQueue(transaction, queueName).enqueue(envelope)
    }
    // Parent locks, immutable Version, capacity and queue share this caller transaction; no object/model I/O here.
    const replayed = await uploadCommand(
      transaction,
      'SELECT knowledge.complete_upload($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) AS status',
      [
        ...target,
        randomUUID(),
        bucket,
        stored.key,
        Buffer.from(stored.sourceHash, 'hex'),
        stored.sourceBytes,
        stored.format,
        capacity.chunks.toString(),
        capacity.physicalBytes.toString(),
        capacity.expiresAt,
        queueName,
        jobId,
        envelope === null ? null : JSON.stringify(envelope),
        maximumFileBytes.toString(),
      ],
    )
    const completed = await transaction.query(
      'SELECT target_version_id::text AS version_id,upload_job_id::text AS job_id FROM knowledge.kb_operations WHERE id=$1 AND document_id=$2',
      [operation.id, operation.documentId],
    )
    const result = completed.rows[0] as { version_id: string; job_id: string } | undefined
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
    if (
      completed.rows.length !== 1 ||
      !result ||
      !uuid.test(result.version_id) ||
      !uuid.test(result.job_id)
    )
      deny('SERVICE_UNAVAILABLE')
    await transaction.query('RELEASE SAVEPOINT knowledge_upload_completion')
    return {
      replayed,
      operationId: operation.id,
      versionId: result.version_id,
      jobId: result.job_id,
    }
  } catch (error) {
    try {
      await transaction.query('ROLLBACK TO SAVEPOINT knowledge_upload_completion')
      await transaction.query('RELEASE SAVEPOINT knowledge_upload_completion')
    } catch {}
    throw error
  }
}
