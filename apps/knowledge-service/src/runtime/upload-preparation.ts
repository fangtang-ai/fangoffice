import {
  parseKnowledgeDocumentTarget,
  parseKnowledgeOperation,
  parseKnowledgeOperationTarget,
  type KnowledgeDocumentTarget,
  type KnowledgeVersion,
} from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'
import { uploadCommand, uploadFact, uploadInput } from './upload-command'

export interface KnowledgeUploadPreparation {
  operationId: string
  idempotencyKey: string
  target: KnowledgeDocumentTarget
  expectedGeneration: bigint
  declaredBytes: bigint
  format: KnowledgeVersion['format']
}

export interface KnowledgeUploadPolicy {
  maximumFileBytes: bigint
}

export async function prepareKnowledgeUpload(
  transaction: KnowledgeTransaction,
  input: KnowledgeUploadPreparation,
  policy: KnowledgeUploadPolicy,
) {
  const target = uploadInput(parseKnowledgeDocumentTarget, input.target)
  const operationTarget = uploadInput(parseKnowledgeOperationTarget, {
    ...target,
    operationId: input.operationId,
  })
  if (
    typeof input.idempotencyKey !== 'string' ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 128 ||
    typeof input.expectedGeneration !== 'bigint' ||
    input.expectedGeneration < 0n ||
    input.expectedGeneration > 9223372036854775807n ||
    typeof input.declaredBytes !== 'bigint' ||
    input.declaredBytes < 1n ||
    input.declaredBytes > 9223372036854775807n ||
    !['txt', 'md', 'docx', 'pdf', 'xlsx'].includes(input.format)
  )
    deny('INVALID_REQUEST')
  if (
    typeof policy.maximumFileBytes !== 'bigint' ||
    policy.maximumFileBytes < 1n ||
    policy.maximumFileBytes > 9223372036854775807n
  )
    deny('NOT_CONFIGURED')
  const replayed = await uploadCommand(
    transaction,
    'SELECT knowledge.prepare_upload($1,$2,$3,$4,$5,$6,$7,$8) AS status',
    [
      operationTarget.operationId,
      input.idempotencyKey,
      target.spaceId,
      target.documentId,
      input.expectedGeneration.toString(),
      input.declaredBytes.toString(),
      input.format,
      policy.maximumFileBytes.toString(),
    ],
  )
  const { rows } = await transaction.query(
    `SELECT jsonb_build_object('id',id,'spaceId',$2::uuid,'documentId',document_id,'kind',kind,
       'phase',phase,'expectedGeneration',expected_generation::text,'targetVersionId',target_version_id,'error',NULL) AS operation,
       staging_key,declared_bytes::text AS bytes,upload_expires_at AS expires_at
       FROM knowledge.kb_operations WHERE idempotency_key = $1 AND document_id = $3`,
    [input.idempotencyKey, target.spaceId, target.documentId],
  )
  const row = rows[0] as
    { operation: unknown; staging_key: string; bytes: string; expires_at: Date } | undefined
  if (
    rows.length !== 1 ||
    !row ||
    !(row.expires_at instanceof Date) ||
    !Number.isFinite(row.expires_at.getTime()) ||
    row.bytes !== input.declaredBytes.toString() ||
    !/^staging\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(row.staging_key)
  )
    deny('SERVICE_UNAVAILABLE')
  const operation = uploadFact((value) => parseKnowledgeOperation(value, target), row.operation)
  if (operation.phase !== 'uploading' || row.staging_key.split('/').at(-1) !== operation.id)
    deny('SERVICE_UNAVAILABLE')
  // 仅返回服务端内部准备事实；签名/上传要等本短事务提交后执行，不能在持锁期间做外部I/O。
  return {
    replayed,
    operation,
    staging: {
      key: row.staging_key,
      maximumBytes: row.bytes,
      expiresAt: row.expires_at.toISOString(),
      format: input.format,
    },
  }
}
