import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { reserveRetryCapacity } from '../src/runtime'

const input = () => ({
  operationId: randomUUID(),
  chunks: 1n,
  physicalBytes: 16n,
  expiresAt: new Date('2099-01-01T00:00:00Z'),
})

it.each([
  { operationId: '' },
  { operationId: 'not-a-uuid' },
  { chunks: -1n },
  { chunks: 9223372036854775808n },
  { physicalBytes: -1n },
  { physicalBytes: 9223372036854775808n },
  { expiresAt: new Date('invalid') },
])('rejects malformed retry input %s before database IO', async (change) => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  await expect(reserveRetryCapacity({ query }, { ...input(), ...change })).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  })
  expect(query).not.toHaveBeenCalled()
})

it.each(['RESERVED', 'REPLAY'] as const)(
  'maps retry admission %s using only the narrow SQL interface',
  async (status) => {
    const request = input()
    const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
    await expect(reserveRetryCapacity({ query }, request)).resolves.toEqual({
      replayed: status === 'REPLAY',
    })
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'SELECT knowledge.reserve_retry_capacity($1, $2, $3, $4) AS status',
      [request.operationId, '1', '16', request.expiresAt.toISOString()],
    )
  },
)

it.each([
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'FORBIDDEN',
  'NOT_CONFIGURED',
  'QUOTA_EXCEEDED',
  'VERSION_CONFLICT',
  'INVALID_REQUEST',
] as const)('preserves retry refusal %s', async (status) => {
  const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
  await expect(reserveRetryCapacity({ query }, input())).rejects.toMatchObject({ code: status })
})

it.each([{ rows: [] }, { rows: [{}] }, { rows: [null] }, { rows: [{ status: 'unexpected' }] }])(
  'fails closed on malformed retry response %j',
  async ({ rows }) => {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }))
    await expect(reserveRetryCapacity({ query }, input())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  },
)
