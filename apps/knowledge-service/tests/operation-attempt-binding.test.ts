import { expect, it, vi } from 'vitest'
import { bindOperationAttempt } from '../src/runtime'

const job = { id: 'synthetic-job', retryCount: 2 }
const envelope = {
  ownerId: 'synthetic-owner',
  operationId: 'operation',
  buildId: 'build',
  receiptId: 'receipt',
}

it('binds only through the narrow SQL entry with every identity component', async () => {
  const query = vi.fn(async () => ({ rows: [{ status: 'BOUND' }], rowCount: 1 }))
  await expect(bindOperationAttempt({ query }, job, envelope)).resolves.toBeUndefined()
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT knowledge.bind_operation_attempt($1, $2, $3, $4, $5, $6) AS status',
    ['synthetic-owner', 'operation', 'build', 'synthetic-job', 2, 'receipt'],
  )
})

it.each(['INVALID_REQUEST', 'UNAUTHENTICATED', 'NOT_FOUND', 'FORBIDDEN', 'VERSION_CONFLICT'])(
  'preserves binding refusal %s',
  async (status) => {
    const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
    await expect(bindOperationAttempt({ query }, job, envelope)).rejects.toMatchObject({
      code: status,
    })
  },
)

it.each([{ rows: [] }, { rows: [null] }, { rows: [{}] }, { rows: [{ status: 'unexpected' }] }])(
  'fails closed for malformed binding response %j',
  async ({ rows }) => {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }))
    await expect(bindOperationAttempt({ query }, job, envelope)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  },
)
