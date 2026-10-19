import { expect, it, vi } from 'vitest'
import { publishBuild, type QueueBuildContext } from '../src/runtime'

const context: QueueBuildContext = {
  ownerId: 'synthetic-owner',
  documentId: 'document',
  operationId: 'operation',
  versionId: 'version',
  buildId: 'build',
  indexProfileId: 'profile',
  expectedGeneration: 0,
  operationKind: 'upload',
  operationPhase: 'queued',
  receiptStatus: 'pending',
}

it.each(['PUBLISHED', 'REPLAY'])('uses only the atomic SQL entry for %s', async (status) => {
  const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
  await expect(publishBuild({ query }, context)).resolves.toEqual({ replayed: status === 'REPLAY' })
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT knowledge.publish_reserved_build($1, $2, $3, $4, $5, $6) AS status',
    ['synthetic-owner', 'document', 'operation', 'version', 'build', 'profile'],
  )
})

it.each([
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'FORBIDDEN',
  'NOT_CONFIGURED',
  'QUOTA_EXCEEDED',
  'VERSION_CONFLICT',
])('preserves publication refusal %s', async (status) => {
  const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
  await expect(publishBuild({ query }, context)).rejects.toMatchObject({ code: status })
})

it.each([{ rows: [] }, { rows: [{}] }, { rows: [null] }, { rows: [{ status: 'unexpected' }] }])(
  'fails closed for malformed response %j',
  async ({ rows }) => {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }))
    await expect(publishBuild({ query }, context)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  },
)
