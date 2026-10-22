import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  createKnowledgeSpace,
  createKnowledgeDocument,
  prepareKnowledgeUpload,
} from '../src/runtime'
import { capacityTransaction, withCapacityFixture } from './capacity-fixtures'
import { uploadMetadata, uploadPolicy, uploadRequest } from './upload-fixtures'

it('replays a fixed session across transactions without renewing expiry or allocating another object', async () => {
  await withCapacityFixture(async (fixture) => {
    const request = uploadRequest(fixture)
    const original = await capacityTransaction(fixture, (transaction) =>
      prepareKnowledgeUpload(transaction, request, uploadPolicy),
    )
    const replay = await capacityTransaction(fixture, (transaction) =>
      prepareKnowledgeUpload(transaction, { ...request, operationId: randomUUID() }, uploadPolicy),
    )
    expect(replay).toEqual({ ...original, replayed: true })
    for (const override of [
      { declaredBytes: 3n },
      { format: 'md' as const },
      { target: { spaceId: fixture.id, documentId: fixture.id } },
      { expectedGeneration: 1n },
      { idempotencyKey: randomUUID() },
    ])
      await expect(
        capacityTransaction(fixture, (transaction) =>
          prepareKnowledgeUpload(transaction, { ...request, ...override }, uploadPolicy),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

it('replays metadata exactly and refuses changed or foreign parent snapshots', async () => {
  await withCapacityFixture(async (fixture) => {
    const spaceId = randomUUID()
    const target = { spaceId, documentId: randomUUID() }
    await capacityTransaction(fixture, async (transaction) => {
      await createKnowledgeSpace(transaction, spaceId, { title: 'Synthetic new space' })
      await createKnowledgeDocument(transaction, target, uploadMetadata)
    })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        createKnowledgeSpace(transaction, spaceId, { title: 'Synthetic new space' }),
      ),
    ).resolves.toMatchObject({ replayed: true })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        createKnowledgeDocument(transaction, target, uploadMetadata),
      ),
    ).resolves.toMatchObject({ replayed: true })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        createKnowledgeSpace(transaction, spaceId, { title: 'Changed title' }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        createKnowledgeDocument(transaction, target, { ...uploadMetadata, purpose: 'style' }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        createKnowledgeDocument(
          transaction,
          { ...target, spaceId: fixture.otherSpaceId },
          uploadMetadata,
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

it('rolls back metadata, session and desired pointer together on interruption', async () => {
  await withCapacityFixture(async (fixture) => {
    const target = { spaceId: randomUUID(), documentId: randomUUID() }
    const request = { ...uploadRequest(fixture), target }
    await expect(
      capacityTransaction(fixture, async (transaction) => {
        await createKnowledgeSpace(transaction, target.spaceId, { title: 'Synthetic rolled back' })
        await createKnowledgeDocument(transaction, target, uploadMetadata)
        await prepareKnowledgeUpload(transaction, request, uploadPolicy)
        throw new Error('synthetic interruption')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await capacityTransaction(fixture, async (transaction) => {
      for (const table of ['kb_spaces', 'kb_documents', 'kb_operations'])
        expect(
          (
            await transaction.query(
              `SELECT id FROM knowledge.${table} WHERE id = ANY($1::uuid[])`,
              [[target.spaceId, target.documentId, request.operationId]],
            )
          ).rows,
        ).toEqual([])
    })
  })
})
