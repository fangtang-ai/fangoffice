import { expect, it, vi } from 'vitest'
import {
  readEmbeddingAttempt,
  recordEmbeddingIntent,
  recordEmbeddingResult,
  type EmbeddingResultRequest,
  type KnowledgeTransaction,
} from '../src/runtime'

const id = '00000000-0000-4000-8000-000000000001'
const result = {
  eventId: id,
  attemptId: id,
  callState: 'completed' as const,
  usage: {
    source: 'provider_reported' as const,
    quantity: { unit: 'tokens' as const, value: '1' },
  },
}

it.each([
  { eventId: 'invalid' },
  { attemptId: 'invalid' },
  { supersedesEventId: 'invalid' },
  { callState: 'intended' },
  { callState: 'unknown' },
  { callState: 'not_called' },
  { usage: { source: 'estimated', quantity: { unit: 'tokens', value: '1' } } },
  ...['-1', '0.5', '1e2', '01', '9223372036854775808'].map((value) => ({
    usage: { source: 'provider_reported', quantity: { unit: 'tokens', value } },
  })),
  { usage: { source: 'unknown', quantity: { unit: 'tokens', value: '0' } } },
  { usage: { source: 'reconciled', quantity: null } },
  { usage: { source: 'reconciled', quantity: { unit: 'bytes', value: '1' } } },
  { supersedesEventId: id, usage: { source: 'unknown', quantity: null } },
])('rejects invalid result input before SQL: %j', async (override) => {
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(
    recordEmbeddingResult(transaction, { ...result, ...override } as EmbeddingResultRequest),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(transaction.query).not.toHaveBeenCalled()
})

it.each([
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'FORBIDDEN',
  'VERSION_CONFLICT',
  'unexpected',
])('preserves bounded refusal %s without fabricating an event', async (status) => {
  const transaction = {
    query: vi
      .fn<KnowledgeTransaction['query']>()
      .mockResolvedValue({ rows: [{ status }], rowCount: 1 }),
  }
  await expect(recordEmbeddingResult(transaction, result)).rejects.toMatchObject({
    code: status === 'unexpected' ? 'SERVICE_UNAVAILABLE' : status,
  })
  expect(transaction.query).toHaveBeenCalledOnce()
})

it('does not fabricate a missing durable event or a missing attempt', async () => {
  const transaction = {
    query: vi
      .fn<KnowledgeTransaction['query']>()
      .mockResolvedValueOnce({ rows: [{ status: 'RECORDED' }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 }),
  }
  await expect(recordEmbeddingResult(transaction, result)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
  })
  await expect(readEmbeddingAttempt(transaction, id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

it('rejects a malformed intent before SQL', async () => {
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(
    recordEmbeddingIntent(transaction, {
      eventId: id,
      attemptId: id,
      indexProfileId: id,
      purpose: 'query',
      subject: { kind: 'query', runId: 'invalid', callId: id },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(transaction.query).not.toHaveBeenCalled()
})
