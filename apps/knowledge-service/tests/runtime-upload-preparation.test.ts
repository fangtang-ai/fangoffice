import { expect, it, vi } from 'vitest'
import {
  createKnowledgeSpace,
  createKnowledgeDocument,
  prepareKnowledgeUpload,
  type KnowledgeTransaction,
  type KnowledgeUploadPreparation,
} from '../src/runtime'

const id = '00000000-0000-4000-8000-000000000001'
const input = {
  operationId: id,
  idempotencyKey: 'synthetic-upload',
  target: { spaceId: id, documentId: id },
  declaredBytes: 4n,
  expectedGeneration: 0n,
  format: 'txt' as const,
}

it.each([
  { operationId: 'invalid' },
  { idempotencyKey: '' },
  { idempotencyKey: ' ' },
  { idempotencyKey: 'x'.repeat(129) },
  { declaredBytes: 0n },
  { declaredBytes: -1n },
  { declaredBytes: 9223372036854775808n },
  { expectedGeneration: -1n },
  { format: 'exe' },
  { target: { spaceId: id, documentId: id, ownerId: 'injected' } },
])('rejects malformed upload input before SQL, case %#', async (override) => {
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(
    prepareKnowledgeUpload(transaction, { ...input, ...override } as KnowledgeUploadPreparation, {
      maximumFileBytes: 16n,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(transaction.query).not.toHaveBeenCalled()
})

it.each([0n, -1n, 9223372036854775808n])(
  'requires an explicit bounded server file limit %s',
  async (maximumFileBytes) => {
    const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
    await expect(
      prepareKnowledgeUpload(transaction, input, { maximumFileBytes }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(transaction.query).not.toHaveBeenCalled()
  },
)

it.each([
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'FORBIDDEN',
  'NOT_CONFIGURED',
  'QUOTA_EXCEEDED',
  'VERSION_CONFLICT',
  'unexpected',
])('preserves refusal %s without fabricating an upload grant', async (status) => {
  const transaction = {
    query: vi
      .fn<KnowledgeTransaction['query']>()
      .mockResolvedValue({ rows: [{ status }], rowCount: 1 }),
  }
  await expect(
    prepareKnowledgeUpload(transaction, input, { maximumFileBytes: 16n }),
  ).rejects.toMatchObject({ code: status === 'unexpected' ? 'SERVICE_UNAVAILABLE' : status })
  expect(transaction.query).toHaveBeenCalledOnce()
})

it('rejects injected owner/object fields in metadata before SQL', async () => {
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(
    createKnowledgeSpace(transaction, id, { title: 'Synthetic', ownerId: 'injected' }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(
    createKnowledgeDocument(transaction, input.target, {
      title: 'Synthetic',
      tags: [],
      purpose: 'facts',
      bucket: 'injected',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(transaction.query).not.toHaveBeenCalled()
})

it('does not invent a committed session when its fact read is empty', async () => {
  const transaction = {
    query: vi
      .fn<KnowledgeTransaction['query']>()
      .mockResolvedValueOnce({ rows: [{ status: 'PREPARED' }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 }),
  }
  await expect(
    prepareKnowledgeUpload(transaction, input, { maximumFileBytes: 16n }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
})
