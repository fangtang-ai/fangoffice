import { expect, it, vi } from 'vitest'
import { sealBuild } from '../src/runtime'

const context = { ownerId: 'synthetic-owner', buildId: 'synthetic-build' }

it('uses one controlled seal statement rather than taking a Build lock before Quota', async () => {
  const query = vi.fn(async () => ({ rows: [{ status: 'SEALED' }], rowCount: 1 }))
  const now = new Date('2026-10-19T00:00:00Z')
  await expect(sealBuild({ query }, context, { synthetic: true }, { now })).resolves.toBeUndefined()
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT knowledge.seal_locked_build($1, $2, $3::jsonb, $4::timestamptz) AS status',
    [context.ownerId, context.buildId, '{"synthetic":true}', now.toISOString()],
  )
})

it.each(['INVALID_REQUEST', 'UNAUTHENTICATED', 'NOT_FOUND', 'FORBIDDEN', 'VERSION_CONFLICT'])(
  'preserves controlled seal refusal %s',
  async (status) => {
    const query = vi.fn(async () => ({ rows: [{ status }], rowCount: 1 }))
    await expect(sealBuild({ query }, context, {})).rejects.toMatchObject({ code: status })
  },
)

it.each([{ rows: [] }, { rows: [{}] }, { rows: [null] }, { rows: [{ status: 'unexpected' }] }])(
  'fails closed for an invalid controlled seal response %j',
  async ({ rows }) => {
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }))
    await expect(sealBuild({ query }, context, {})).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  },
)
