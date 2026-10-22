import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createKnowledgeDocument, prepareKnowledgeUpload } from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { capacityTransaction } from './capacity-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { uploadMetadata, uploadPolicy, uploadRequest } from './upload-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes duplicate upload sessions behind a real %s wait',
  async (outcome) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      const request = uploadRequest(fixture)
      const first = await prepareKnowledgeUpload(writer, request, uploadPolicy)
      const nextId = randomUUID()
      const waiting = prepareKnowledgeUpload(
        waiter,
        { ...request, operationId: nextId },
        uploadPolicy,
      )
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query(outcome)
      await expect(waiting).resolves.toMatchObject({
        replayed: outcome === 'COMMIT',
        operation: { id: outcome === 'COMMIT' ? first.operation.id : nextId },
      })
      await waiter.query('COMMIT')
    })
  },
)

it('rechecks aggregate pending capacity after a competing upload commits', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    const target = { spaceId: fixture.id, documentId: randomUUID() }
    await capacityTransaction(fixture, (transaction) =>
      createKnowledgeDocument(transaction, target, uploadMetadata),
    )
    await prepareKnowledgeUpload(writer, uploadRequest(fixture), uploadPolicy)
    const waiting = expect(
      prepareKnowledgeUpload(waiter, { ...uploadRequest(fixture), target }, uploadPolicy),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('COMMIT')
    await waiting
    await waiter.query('ROLLBACK')
  })
})
