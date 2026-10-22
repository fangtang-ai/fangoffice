import { expect, it, vi } from 'vitest'
import { closeStorageWindow, type KnowledgeTransaction } from '../src/runtime'

const request = {
  windowId: '00000000-0000-4000-8000-000000000001',
  startAt: new Date('2026-10-01T16:00:00.000Z'),
  endAt: new Date('2026-10-02T16:00:00.000Z'),
  tariffRevision: 'synthetic-storage-v1',
}

it.each([
  { windowId: 'invalid' },
  { startAt: new Date(Number.NaN) },
  { endAt: new Date(Number.NaN) },
])('rejects malformed input before using the database: %j', async (override) => {
  const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
  await expect(closeStorageWindow(transaction, { ...request, ...override })).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  })
  expect(transaction.query).not.toHaveBeenCalled()
})

it.each(['', ' ', 'a'.repeat(129)])(
  'rejects missing or unbounded tariffs before database work',
  async (tariffRevision) => {
    const transaction = { query: vi.fn<KnowledgeTransaction['query']>() }
    await expect(
      closeStorageWindow(transaction, { ...request, tariffRevision }),
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
])('preserves the bounded SQL refusal %s', async (status) => {
  const transaction = {
    query: vi
      .fn<KnowledgeTransaction['query']>()
      .mockResolvedValue({ rows: [{ status }], rowCount: 1 }),
  }
  await expect(closeStorageWindow(transaction, request)).rejects.toMatchObject({ code: status })
  expect(transaction.query).toHaveBeenCalledOnce()
})

it.each([[], [{ status: 'unexpected' }], [{ status: null }]].map((rows) => ({ rows })))(
  'fails closed on an unknown close response: $rows',
  async ({ rows }) => {
    const transaction = {
      query: vi
        .fn<KnowledgeTransaction['query']>()
        .mockResolvedValue({ rows, rowCount: rows.length }),
    }
    await expect(closeStorageWindow(transaction, request)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
    expect(transaction.query).toHaveBeenCalledOnce()
  },
)

it.each([[], [{ window_start: new Date(Number.NaN) }]].map((rows) => ({ rows })))(
  'does not invent a missing or invalid persisted window: $rows',
  async ({ rows }) => {
    const transaction = {
      query: vi
        .fn<KnowledgeTransaction['query']>()
        .mockResolvedValueOnce({ rows: [{ status: 'CLOSED' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows, rowCount: rows.length }),
    }
    await expect(closeStorageWindow(transaction, request)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  },
)
