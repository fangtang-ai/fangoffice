import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  applyKnowledgeDeletionIntent,
  closeStorageWindow,
  publishBuild,
  reserveReplacementCapacity,
} from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import {
  preparePublicationBuild,
  publicationTransaction,
  withPublicationFixture,
} from './publication-fixtures'
import { replacementInput, withReplacementFixture } from './replacement-fixtures'
import { placeStorageHistory, storageState, storageWindow } from './storage-window-fixtures'

it('integrates real publication and tombstone facts and stays zero while physical debt remains', async () => {
  await withPublicationFixture(async (fixture) => {
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )
    await capacityTransaction(fixture, (transaction) =>
      applyKnowledgeDeletionIntent(transaction, {
        schemaVersion: 1,
        id: randomUUID(),
        ownerId: fixture.owners[0],
        recordedAt: Date.now(),
        scope: { kind: 'document', spaceId: fixture.id, documentId: fixture.id },
      }),
    )
    await placeStorageHistory(fixture, [0, 43200000])
    const close = (day: number) =>
      publicationTransaction(fixture, (transaction) =>
        closeStorageWindow(transaction, storageWindow(day)),
      )
    await expect(close(0)).resolves.toMatchObject({
      event: { usage: { quantity: { value: '172800000' } } },
    })
    await expect(close(1)).resolves.toMatchObject({
      event: { usage: { quantity: { value: '0' } } },
    })
    await publicationTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query(
            'SELECT physical_accounted_bytes::text AS debt FROM knowledge.kb_quotas',
          )
        ).rows,
      ).toEqual([{ debt: '16' }])
    })
  })
})

it('swaps actual replacement bytes once and stops at the real deletion watermark', async () => {
  await withReplacementFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveReplacementCapacity(transaction, replacementInput(fixture)),
    )
    const context = await preparePublicationBuild(fixture, fixture.replacementId)
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, context))
    await capacityTransaction(fixture, (transaction) =>
      applyKnowledgeDeletionIntent(transaction, {
        schemaVersion: 1,
        id: randomUUID(),
        ownerId: fixture.owners[0],
        recordedAt: Date.now(),
        scope: { kind: 'document', spaceId: fixture.id, documentId: fixture.id },
      }),
    )
    await placeStorageHistory(fixture, [0, 43200000, 64800000])
    await expect(
      publicationTransaction(fixture, (transaction) =>
        closeStorageWindow(transaction, storageWindow()),
      ),
    ).resolves.toMatchObject({
      event: {
        subject: { openingSequence: '0', closingSequence: '3' },
        usage: { quantity: { value: '302400000' } },
      },
    })
    expect(await storageState(fixture)).toHaveLength(1)
  })
})
