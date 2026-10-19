import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { cancelCapacityReservation } from '../src/runtime'

it.each(['', 'not-a-uuid', '123', '00000000-0000-0000-0000-00000000000z'])(
  'rejects malformed operation ID %j before querying',
  async (operationId) => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    await expect(cancelCapacityReservation({ query }, operationId)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(query).not.toHaveBeenCalled()
  },
)

it.each(['CANCELLED', 'REPLAY'] as const)(
  'maps the narrow cancellation result %s',
  async (status) => {
    const operationId = randomUUID()
    const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
    await expect(cancelCapacityReservation({ query }, operationId)).resolves.toEqual({
      replayed: status === 'REPLAY',
    })
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'SELECT knowledge.cancel_capacity_reservation($1) AS status',
      [operationId],
    )
  },
)

it.each(['UNAUTHENTICATED', 'NOT_FOUND', 'FORBIDDEN', 'VERSION_CONFLICT'] as const)(
  'preserves the business refusal %s',
  async (status) => {
    const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
    await expect(cancelCapacityReservation({ query }, randomUUID())).rejects.toMatchObject({
      code: status,
    })
  },
)

it.each([{ rows: [] }, { rows: [{ status: 'unknown' }] }, { rows: [{}] }, { rows: [null] }])(
  'fails closed on malformed database response %j',
  async ({ rows }) => {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }))
    await expect(cancelCapacityReservation({ query }, randomUUID())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  },
)
