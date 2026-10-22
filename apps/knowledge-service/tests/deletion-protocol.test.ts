import { expect, it, vi } from 'vitest'
import * as runtime from '../src/runtime'
import { ids, now, principal } from './fixtures'

it('does not enter the database deletion step when the independent journal cannot confirm the intent', async () => {
  const apply = vi.fn(async (_intent: unknown) => 'DELETED' as const)
  const journal = { append: vi.fn(async (_intent: unknown) => { throw new Error('synthetic-private-log-error') }) }
  await expect(runtime.deleteKnowledgeScope(principal(), {
    id: ids.operation, scope: { kind: 'document', spaceId: ids.space, documentId: ids.document },
  }, journal, apply, { now: () => now })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(apply).not.toHaveBeenCalled()
})
