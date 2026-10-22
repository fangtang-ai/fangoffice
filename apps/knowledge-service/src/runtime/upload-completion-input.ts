import { parseKnowledgeOperation } from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { CapacityReservationRequest } from './capacity'
import type { prepareKnowledgeUpload, KnowledgeUploadPolicy } from './upload-preparation'
import type { saveKnowledgeTextUpload } from './upload-source'
import { uploadFact } from './upload-command'

export interface KnowledgeUploadCompletion {
  prepared: Awaited<ReturnType<typeof prepareKnowledgeUpload>>
  stored: Awaited<ReturnType<typeof saveKnowledgeTextUpload>>
  capacity: Omit<CapacityReservationRequest, 'operationId'>
}

export interface KnowledgeUploadCompletionPolicy extends KnowledgeUploadPolicy {
  bucket: string
  queueName: string
}

export function completionInput(
  input: KnowledgeUploadCompletion,
  policy: KnowledgeUploadCompletionPolicy,
) {
  const { bucket, queueName, maximumFileBytes } = policy
  if (
    typeof maximumFileBytes !== 'bigint' ||
    maximumFileBytes < 1n ||
    maximumFileBytes > 9223372036854775807n ||
    typeof bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    typeof queueName !== 'string' ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(queueName)
  )
    deny('NOT_CONFIGURED')
  const operation = uploadFact(
    (value) =>
      parseKnowledgeOperation(value, {
        spaceId: input.prepared.operation.spaceId,
        documentId: input.prepared.operation.documentId,
      }),
    input.prepared.operation,
  )
  const staging = { ...input.prepared.staging }
  const stored = { ...input.stored }
  if (
    operation.kind !== 'upload' ||
    operation.phase !== 'uploading' ||
    !/^staging\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(staging.key) ||
    staging.key.split('/').at(-1) !== operation.id ||
    !Number.isFinite(Date.parse(staging.expiresAt)) ||
    stored.status !== 'stored_source' ||
    !/^[a-f0-9]{64}$/.test(stored.sourceHash) ||
    !/^[1-9]\d{0,18}$/.test(stored.sourceBytes) ||
    BigInt(stored.sourceBytes) > 9223372036854775807n ||
    stored.sourceBytes !== staging.maximumBytes ||
    stored.format !== staging.format ||
    !['txt', 'md'].includes(stored.format) ||
    stored.mimeType !== (stored.format === 'txt' ? 'text/plain' : 'text/markdown') ||
    stored.key !==
      `originals/${staging.key.split('/')[1]}/${operation.documentId}/${operation.id}` ||
    typeof stored.etag !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/.test(stored.etag)
  )
    deny('INVALID_REQUEST')
  if (BigInt(stored.sourceBytes) > maximumFileBytes) deny('QUOTA_EXCEEDED')
  const { chunks, physicalBytes, expiresAt } = input.capacity
  if (
    [chunks, physicalBytes].some(
      (value) => typeof value !== 'bigint' || value < 0n || value > 9223372036854775807n,
    ) ||
    physicalBytes < BigInt(stored.sourceBytes) ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime())
  )
    deny('INVALID_REQUEST')
  return {
    operation,
    stored,
    bucket,
    queueName,
    maximumFileBytes,
    capacity: { chunks, physicalBytes, expiresAt: expiresAt.toISOString() },
  }
}
