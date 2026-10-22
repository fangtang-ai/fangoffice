import { randomUUID } from 'node:crypto'
import type { CapacityFixture } from './capacity-fixtures'

export const uploadRequest = (fixture: CapacityFixture) => ({
  operationId: randomUUID(),
  idempotencyKey: randomUUID(),
  target: { spaceId: fixture.id, documentId: fixture.otherDocumentId },
  expectedGeneration: 0n,
  declaredBytes: 4n,
  format: 'txt' as const,
})

export const uploadPolicy = { maximumFileBytes: 16n }
export const uploadMetadata = { title: 'Synthetic upload', tags: ['synthetic'], purpose: 'facts' }
