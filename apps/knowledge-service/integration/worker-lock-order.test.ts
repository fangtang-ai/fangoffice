import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  claimBuild,
  publishBuild,
  resolveQueueBuild,
  sealBuild,
  writeBuildContent,
} from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { admitPublication, publicationState } from './publication-fixtures'

const sourceUnit = () => ({
  id: randomUUID(),
  ordinal: 1,
  type: 'paragraph',
  text: 'Synthetic lock-order probe',
  textHash: Buffer.alloc(32, 1),
  locator: {},
  coverage: {},
  warnings: [],
})

it('finishes claim, seal and publication while cancellation waits without a reverse quota lock', async () => {
  await withCapacityRace(
    async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      await admitPublication(fixture)
      const context = await claimBuild(
        writer,
        { id: randomUUID(), retryCount: 0 },
        {
          ownerId: fixture.owners[0],
          operationId: fixture.id,
          buildId: randomUUID(),
          receiptId: fixture.id,
        },
        { indexProfileId: fixture.profileId, parserRevision: 'synthetic', parserSnapshot: {} },
      )
      const cancelling = cancelCapacityReservation(waiter, fixture.id).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, waiterPid, writerPid)
      await sealBuild(writer, context, {})
      await expect(publishBuild(writer, context)).resolves.toEqual({ replayed: false })
      await writer.query('COMMIT')
      await expect(cancelling).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
      await waiter.query('COMMIT')
    },
    'api',
    'worker',
  )
})

it.each(['content', 'seal'] as const)(
  'finishes publication after %s acquired the first lock while cancellation waits',
  async (entry) => {
    await withCapacityRace(
      async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
        await admitPublication(fixture)
        const context = await resolveQueueBuild(
          writer,
          { id: fixture.id, retryCount: 0 },
          {
            ownerId: fixture.owners[0],
            operationId: fixture.id,
            buildId: fixture.id,
            receiptId: fixture.id,
          },
        )
        if (entry === 'content') {
          await writeBuildContent(writer, context, { sourceUnits: [sourceUnit()] })
        } else {
          await sealBuild(writer, context, {})
        }
        const cancelling = cancelCapacityReservation(waiter, fixture.id).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
        await expectBlocked(observer, waiterPid, writerPid)
        if (entry === 'content') await sealBuild(writer, context, {})
        await expect(publishBuild(writer, context)).resolves.toEqual({ replayed: false })
        await writer.query('COMMIT')
        await expect(cancelling).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
        await waiter.query('COMMIT')
      },
      'api',
      'worker',
    )
  },
)

for (const entry of ['content', 'seal'] as const) {
  it.each(['COMMIT', 'ROLLBACK'] as const)(
    `rechecks ${entry} after waiting behind cancellation's %s`,
    async (outcome) => {
      await withCapacityRace(
        async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
          await admitPublication(fixture)
          const context = { ownerId: fixture.owners[0], buildId: fixture.id }
          await cancelCapacityReservation(writer, fixture.id)
          const waiting = (
            entry === 'content'
              ? writeBuildContent(waiter, context, { sourceUnits: [sourceUnit()] })
              : sealBuild(waiter, context, {})
          ).then(
            () => ({ completed: true }),
            (error: unknown) => ({ error }),
          )
          await expectBlocked(observer, waiterPid, writerPid)
          await writer.query(outcome)
          await expect(waiting).resolves.toMatchObject(
            outcome === 'ROLLBACK'
              ? { completed: true }
              : { error: { code: entry === 'content' ? '23514' : 'FORBIDDEN' } },
          )
          await waiter.query(outcome === 'COMMIT' && entry === 'content' ? 'ROLLBACK' : 'COMMIT')
        },
        'worker',
      )
    },
  )
}

it('serializes two same-owner worker seals without a SHARE-to-UPDATE upgrade deadlock', async () => {
  await withCapacityRace(
    async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      const context = { ownerId: fixture.owners[0], buildId: fixture.id }
      await sealBuild(writer, context, {})
      const sealing = sealBuild(waiter, context, {}).then(
        () => ({ completed: true }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query('COMMIT')
      await expect(sealing).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
      await waiter.query('COMMIT')
    },
    'worker',
    'worker',
  )
})

it('rolls back a controlled seal and publication together after a later SQL failure', async () => {
  await withCapacityRace(
    async ({ fixture, writer, observer }) => {
      await admitPublication(fixture)
      const context = await resolveQueueBuild(
        writer,
        { id: fixture.id, retryCount: 0 },
        {
          ownerId: fixture.owners[0],
          operationId: fixture.id,
          buildId: fixture.id,
          receiptId: fixture.id,
        },
      )
      const before = await publicationState(fixture)
      await sealBuild(writer, context, { synthetic: true })
      await publishBuild(writer, context)
      await expect(writer.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' })
      await writer.query('ROLLBACK')
      expect(await publicationState(fixture)).toEqual(before)
      expect(
        (
          await observer.query(
            'SELECT status, manifest FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([{ status: 'building', manifest: null }])
    },
    'worker',
    'worker',
  )
})
