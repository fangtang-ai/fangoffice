import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { cancelCapacityReservation, claimBuild } from '../src/runtime'
import { bindSeedBuild } from './build-fixtures'
import { expectBlocked } from './build-race-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { admitPublication } from './publication-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes competing jobs after the first claim chooses %s',
  async (outcome) => {
    await withCapacityRace(
      async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
        const options = {
          indexProfileId: fixture.profileId,
          parserRevision: 'synthetic',
          parserSnapshot: {},
        }
        const envelope = {
          ownerId: fixture.owners[0],
          operationId: fixture.id,
          receiptId: fixture.id,
        }
        const winner = await claimBuild(
          writer,
          { id: randomUUID(), retryCount: 0 },
          { ...envelope, buildId: randomUUID() },
          options,
        )
        const waitingId = randomUUID()
        const waiting = claimBuild(
          waiter,
          { id: randomUUID(), retryCount: 1 },
          { ...envelope, buildId: waitingId },
          options,
        ).then(
          (context) => ({ context }),
          (error: unknown) => ({ error }),
        )
        await expectBlocked(observer, waiterPid, writerPid)
        await writer.query(outcome)
        await expect(waiting).resolves.toMatchObject(
          outcome === 'COMMIT'
            ? { error: { code: '23514', constraint: 'kb_build_cancel_fence' } }
            : { context: { buildId: waitingId } },
        )
        await waiter.query(outcome === 'COMMIT' ? 'ROLLBACK' : 'COMMIT')
        expect(
          (
            await observer.query(
              'SELECT current_build_id FROM knowledge.kb_operations WHERE owner_id = $1 AND id = $2',
              [fixture.owners[0], fixture.id],
            )
          ).rows,
        ).toEqual([{ current_build_id: outcome === 'COMMIT' ? winner.buildId : waitingId }])
        expect(
          (
            await observer.query(
              'SELECT count(*)::int AS count FROM knowledge.kb_builds WHERE owner_id = $1',
              [fixture.owners[0]],
            )
          ).rows,
        ).toEqual([{ count: 2 }])
      },
      'worker',
      'worker',
    )
  },
)

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'rechecks binding after cancellation chooses %s',
  async (outcome) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      await admitPublication(fixture)
      await cancelCapacityReservation(writer, fixture.id)
      const waiting = bindSeedBuild(waiter, fixture).then(
        () => ({ bound: true }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query(outcome)
      await expect(waiting).resolves.toMatchObject(
        outcome === 'COMMIT' ? { error: { code: 'FORBIDDEN' } } : { bound: true },
      )
      await waiter.query('COMMIT')
      expect(
        (
          await observer.query(
            'SELECT current_build_id FROM knowledge.kb_operations WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([{ current_build_id: outcome === 'COMMIT' ? null : fixture.id }])
    }, 'worker')
  },
)
