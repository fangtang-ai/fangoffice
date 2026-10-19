import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  publishBuild,
  reserveInitialCapacity,
  reserveReplacementCapacity,
  reserveRetryCapacity,
} from '../src/runtime'
import {
  addCapacityUpload,
  capacityInput,
  capacityTransaction,
  changeCapacityFixture,
} from './capacity-fixtures'
import {
  expectPublishedCapacity,
  preparePublicationBuild,
  publicationState,
  publicationTransaction,
  withPublicationFixture,
} from './publication-fixtures'
import { replacementInput, withReplacementFixture } from './replacement-fixtures'
import { addFollowupUpload } from './retry-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it('publishes, promotes held capacity and appends one ordered storage fact in the same worker transaction', async () => {
  await withPublicationFixture(async (fixture) => {
    expect(
      (
        await publicationTransaction(fixture, (transaction) =>
          transaction.query(
            'SELECT knowledge.publish_reserved_build($1, $2, $3, $4, $5, $6) AS status',
            [fixture.owners[0], fixture.id, fixture.id, fixture.id, fixture.id, fixture.profileId],
          ),
        )
      ).rows,
    ).toEqual([{ status: 'PUBLISHED' }])
    await expectPublishedCapacity(fixture)
  })
})

it('replays the winner without a second capacity transfer, event or generation', async () => {
  await withPublicationFixture(async (fixture) => {
    const publish = () =>
      publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context))
    await expect(publish()).resolves.toEqual({ replayed: false })
    const before = await publicationState(fixture)
    await expect(publish()).resolves.toEqual({ replayed: true })
    expect(await publicationState(fixture)).toEqual(before)
    await expectPublishedCapacity(fixture)
  })
})

it('rolls publication, capacity and event back together when later work fails', async () => {
  await withPublicationFixture(async (fixture) => {
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, async (transaction) => {
        await publishBuild(transaction, fixture.context)
        await transaction.query('SELECT 1 / 0')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await publicationState(fixture)).toEqual(before)
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )
    await expectPublishedCapacity(fixture)
  })
})

it('does not publish a cancelled operation or release its physical debt', async () => {
  await withPublicationFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.id),
    )
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await publicationState(fixture)).toEqual(before)
  })
})

it.each([2n, 6n])(
  'replaces four active bytes with %s actual bytes and keeps old physical debt',
  async (versionBytes) => {
    await withReplacementFixture(
      async (fixture) => {
        await capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, replacementInput(fixture)),
        )
        const context = await preparePublicationBuild(fixture, fixture.replacementId)
        await publicationTransaction(fixture, (transaction) => publishBuild(transaction, context))
        await inRoleTransaction('api', fixture.owners[0], async (client) => {
          expect(
            (
              await client.query(
                `SELECT active_files::text AS files, active_bytes::text AS bytes,
        active_chunks::text AS chunks, reserved_bytes::text AS reserved, reserved_chunks::text AS reserved_chunks,
        physical_reserved_bytes::text AS physical_reserved, physical_accounted_bytes::text AS physical_accounted
        FROM knowledge.kb_quotas WHERE owner_id = $1`,
                [fixture.owners[0]],
              )
            ).rows,
          ).toEqual([
            {
              files: '1',
              bytes: versionBytes.toString(),
              chunks: '1',
              reserved: '0',
              reserved_chunks: '0',
              physical_reserved: '0',
              physical_accounted: '96',
            },
          ])
          expect(
            (
              await client.query(
                `SELECT sequence::text AS sequence, active_bytes_before::text AS before,
        active_bytes_after::text AS after FROM knowledge.kb_metering_events
        WHERE owner_id = $1 ORDER BY sequence`,
                [fixture.owners[0]],
              )
            ).rows,
          ).toEqual([
            { sequence: '1', before: '0', after: '4' },
            { sequence: '2', before: '4', after: versionBytes.toString() },
          ])
          expect(
            (
              await client.query(
                `SELECT status, gc_state, chunk_count::text AS chunks
        FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2`,
                [fixture.owners[0], fixture.id],
              )
            ).rows,
          ).toEqual([{ status: 'sealed', gc_state: 'live', chunks: '1' }])
        })
        const before = await publicationState(fixture)
        await expect(
          publicationTransaction(fixture, (transaction) => publishBuild(transaction, context)),
        ).resolves.toEqual({ replayed: true })
        expect(await publicationState(fixture)).toEqual(before)
      },
      { versionBytes },
    )
  },
)

it('orders publications of separate documents by owner and safely replays an older result', async () => {
  await withPublicationFixture(async (fixture) => {
    await changeCapacityFixture(
      fixture,
      'UPDATE knowledge.kb_quotas SET limit_files = 2, limit_bytes = 8, limit_chunks = 2 WHERE owner_id = $1',
    )
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )
    const operationId = await addCapacityUpload(fixture)
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, { ...capacityInput(fixture), operationId }),
    )
    const next = await preparePublicationBuild(fixture, operationId)
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, next))
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context)),
    ).resolves.toEqual({ replayed: true })
    expect(await publicationState(fixture)).toEqual(before)
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            `SELECT sequence::text AS sequence, active_bytes_before::text AS before,
        active_bytes_after::text AS after FROM knowledge.kb_metering_events WHERE owner_id = $1 ORDER BY sequence`,
            [fixture.owners[0]],
          )
        ).rows,
      ).toEqual([
        { sequence: '1', before: '0', after: '4' },
        { sequence: '2', before: '4', after: '8' },
      ])
    })
  })
})

it('promotes only the retry reservation while retaining cancelled physical debt', async () => {
  await withPublicationFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.id),
    )
    const operationId = await addFollowupUpload(fixture)
    await capacityTransaction(fixture, (transaction) =>
      reserveRetryCapacity(transaction, { ...capacityInput(fixture), operationId }),
    )
    const context = await preparePublicationBuild(fixture, operationId)
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, context))
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            `SELECT active_bytes::text AS bytes, physical_reserved_bytes::text AS reserved,
        physical_accounted_bytes::text AS accounted FROM knowledge.kb_quotas WHERE owner_id = $1`,
            [fixture.owners[0]],
          )
        ).rows,
      ).toEqual([{ bytes: '4', reserved: '16', accounted: '16' }])
    })
  })
})

it('publishes through the public runtime without direct document-write privileges', async () => {
  await withPublicationFixture(async (fixture) => {
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )
    await expectPublishedCapacity(fixture)
  })
})
