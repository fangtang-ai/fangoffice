import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  createKnowledgeSpace,
  createKnowledgeDocument,
  prepareKnowledgeUpload,
} from '../src/runtime'
import { capacityTransaction, withCapacityFixture } from './capacity-fixtures'

it('creates private metadata and a durable, fixed-object upload intent without a ready version', async () => {
  await withCapacityFixture(async (fixture) => {
    const spaceId = randomUUID()
    const documentId = randomUUID()
    const operationId = randomUUID()
    const outcome = await capacityTransaction(fixture, async (transaction) => {
      expect(
        await createKnowledgeSpace(transaction, spaceId, { title: 'Synthetic space' }),
      ).toMatchObject({ replayed: false, space: { id: spaceId, state: 'active' } })
      expect(
        await createKnowledgeDocument(
          transaction,
          { spaceId, documentId },
          { title: 'Synthetic TXT', tags: ['synthetic'], purpose: 'facts' },
        ),
      ).toMatchObject({
        replayed: false,
        document: { id: documentId, generation: '0', active: null, desired: null },
      })
      return prepareKnowledgeUpload(
        transaction,
        {
          operationId,
          idempotencyKey: randomUUID(),
          target: { spaceId, documentId },
          expectedGeneration: 0n,
          declaredBytes: 4n,
          format: 'txt',
        },
        { maximumFileBytes: 16n },
      )
    })
    expect(outcome).toMatchObject({
      replayed: false,
      operation: { id: operationId, kind: 'upload', phase: 'uploading', targetVersionId: null },
      staging: {
        key: expect.stringMatching(/^staging\/[a-f0-9]{64}\/[a-f0-9-]{36}$/),
        maximumBytes: '4',
      },
    })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id = $1', [
            documentId,
          ])
        ).rows,
      ).toEqual([])
    })
  })
})
