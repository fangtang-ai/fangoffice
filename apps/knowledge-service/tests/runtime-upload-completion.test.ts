import { expect, it, vi } from 'vitest'
import {
  completeKnowledgeUpload,
  type KnowledgeTransaction,
  type KnowledgeUploadCompletion,
} from '../src/runtime'
import { ossUploadPrepared } from './oss-upload-fixtures'

function completion() {
  return {
    prepared: ossUploadPrepared,
    stored: {
      status: 'stored_source' as const,
      key: `originals/${'a'.repeat(64)}/${ossUploadPrepared.operation.documentId}/${ossUploadPrepared.operation.id}`,
      etag: '"synthetic-original"',
      sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      sourceBytes: '4',
      format: 'txt',
      mimeType: 'text/plain',
    },
    capacity: { chunks: 1n, physicalBytes: 16n, expiresAt: new Date('2026-10-21T12:00:00.000Z') },
  } satisfies KnowledgeUploadCompletion
}
const policy = {
  bucket: 'synthetic-private-knowledge',
  queueName: 'synthetic_upload',
  maximumFileBytes: 16n,
}

it.each([
  { key: 'staging/not-an-original' },
  { sourceHash: 'invalid' },
  { sourceHash: 'b'.repeat(63) },
  { sourceBytes: '0' },
  { sourceBytes: '5' },
  { sourceBytes: '9223372036854775808' },
  { format: 'pdf' },
  { mimeType: 'application/octet-stream' },
  { etag: 'bad\nrevision' },
])('rejects malformed or unbound stored-source facts before SQL, case %#', async (stored) => {
  const input = completion()
  Object.assign(input.stored, stored)
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(completeKnowledgeUpload(transaction, input, policy)).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  })
  expect(transaction.query).not.toHaveBeenCalled()
})

it.each([
  { chunks: -1n },
  { chunks: 9223372036854775808n },
  { physicalBytes: 3n },
  { physicalBytes: 9223372036854775808n },
  { expiresAt: new Date(Number.NaN) },
])('rejects invalid capacity before SQL, case %#', async (capacity) => {
  const input = completion()
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(
    completeKnowledgeUpload(
      transaction,
      { ...input, capacity: { ...input.capacity, ...capacity } },
      policy,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(transaction.query).not.toHaveBeenCalled()
})

it.each([
  { maximumFileBytes: 0n },
  { maximumFileBytes: 9223372036854775808n },
  { bucket: 'https://other.invalid' },
  { bucket: 'Uppercase-Bucket' },
  { queueName: 'unsafe.queue' },
])('requires explicit bounded server policy, case %#', async (override) => {
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(
    completeKnowledgeUpload(transaction, completion(), { ...policy, ...override }),
  ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  expect(transaction.query).not.toHaveBeenCalled()
})

it.each([
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'FORBIDDEN',
  'NOT_CONFIGURED',
  'QUOTA_EXCEEDED',
  'VERSION_CONFLICT',
  'unexpected',
])('preserves the completion-lock refusal %s and never sends a job', async (status) => {
  const transaction = {
    query: vi
      .fn<KnowledgeTransaction['query']>()
      .mockResolvedValue({ rows: [{ status }], rowCount: 1 }),
  }
  await expect(completeKnowledgeUpload(transaction, completion(), policy)).rejects.toMatchObject({
    code: status === 'unexpected' ? 'SERVICE_UNAVAILABLE' : status,
  })
  expect(transaction.query).toHaveBeenCalledOnce()
})

it('does not accept an operation identity that fails the shared contract', async () => {
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  const input: KnowledgeUploadCompletion = completion()
  input.prepared = { ...input.prepared, operation: { ...input.prepared.operation, id: 'invalid' } }
  await expect(completeKnowledgeUpload(transaction, input, policy)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
  })
  expect(transaction.query).not.toHaveBeenCalled()
})
