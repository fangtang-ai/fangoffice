import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { cancelCapacityReservation, publishBuild } from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { changeCapacityFixture } from './capacity-fixtures'
import { expectPublishedCapacity, preparePublication } from './publication-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes duplicate publication after %s',
  async (outcome) => {
    await withCapacityRace(
      async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
        const { context } = await preparePublication(fixture)
        await publishBuild(writer, context)
        const waiting = publishBuild(waiter, context)
        await expectBlocked(observer, waiterPid, writerPid)
        await writer.query(outcome)
        await expect(waiting).resolves.toEqual({ replayed: outcome === 'COMMIT' })
        await waiter.query('COMMIT')
        await expectPublishedCapacity(fixture)
      },
      'worker',
      'worker',
    )
  },
)

it('rechecks reservation expiry after a real quota-lock wait', async () => {
  await withCapacityRace(
    async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      const { context } = await preparePublication(fixture)
      await changeCapacityFixture(
        fixture,
        `UPDATE knowledge.kb_reservations
      SET expires_at = clock_timestamp() + interval '1 second' WHERE owner_id = $1`,
      )
      await expect(
        publishBuild(writer, { ...context, documentId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const waiting = publishBuild(waiter, context)
      await expectBlocked(observer, waiterPid, writerPid)
      await vi.waitFor(
        async () => {
          expect(
            (
              await observer.query(
                'SELECT expires_at <= clock_timestamp() AS expired FROM knowledge.kb_reservations WHERE owner_id = $1',
                [fixture.owners[0]],
              )
            ).rows,
          ).toEqual([{ expired: true }])
        },
        { timeout: 2000, interval: 20 },
      )
      await writer.query('COMMIT')
      await expect(waiting).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await waiter.query('COMMIT')
    },
    'worker',
    'worker',
  )
})

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'rechecks cancellation after waiting for %s',
  async (outcome) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      const { context } = await preparePublication(fixture)
      await cancelCapacityReservation(writer, fixture.id)
      const waiting = publishBuild(waiter, context)
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query(outcome)
      if (outcome === 'COMMIT') {
        await expect(waiting).rejects.toMatchObject({ code: 'FORBIDDEN' })
      } else {
        await expect(waiting).resolves.toEqual({ replayed: false })
      }
      await waiter.query('COMMIT')
      if (outcome === 'ROLLBACK') await expectPublishedCapacity(fixture)
    }, 'worker')
  },
)

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'rechecks publication before cancellation after %s',
  async (outcome) => {
    await withCapacityRace(
      async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
        const { context } = await preparePublication(fixture)
        await publishBuild(writer, context)
        const waiting = cancelCapacityReservation(waiter, fixture.id)
        await expectBlocked(observer, waiterPid, writerPid)
        await writer.query(outcome)
        if (outcome === 'COMMIT') {
          await expect(waiting).rejects.toMatchObject({ code: 'FORBIDDEN' })
        } else {
          await expect(waiting).resolves.toEqual({ replayed: false })
        }
        await waiter.query('COMMIT')
        if (outcome === 'COMMIT') await expectPublishedCapacity(fixture)
      },
      'api',
      'worker',
    )
  },
)
