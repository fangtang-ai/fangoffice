import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  claimBuild,
  reserveInitialCapacity,
  writeBuildContent,
} from '../src/runtime'
import { cancellationState } from './cancellation-fixtures'
import { expectBlocked } from './build-race-fixtures'
import { bindSeedBuild } from './build-fixtures'
import { addCapacityUpload, capacityInput, capacityTransaction } from './capacity-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes duplicate cancellation after the first transaction chooses %s',
  async (outcome) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await cancelCapacityReservation(writer, fixture.id)
      const waiting = cancelCapacityReservation(waiter, fixture.id)
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query(outcome)
      await expect(waiting).resolves.toEqual({ replayed: outcome === 'COMMIT' })
      await waiter.query('COMMIT')
      expect(await cancellationState(fixture)).toMatchObject({
        generation: '1',
        state: 'released',
        files: '0',
        bytes: '0',
        chunks: '0',
        physical: '16',
      })
    })
  },
)

it('rejects a real worker claim that was waiting behind an uncommitted cancellation', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await cancelCapacityReservation(writer, fixture.id)
    const waiting = claimBuild(
      waiter,
      { id: randomUUID(), retryCount: 0 },
      {
        ownerId: fixture.owners[0],
        operationId: fixture.id,
        buildId: randomUUID(),
        receiptId: fixture.id,
      },
      { indexProfileId: fixture.profileId, parserRevision: 'synthetic', parserSnapshot: {} },
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('COMMIT')
    await expect(waiting).resolves.toMatchObject({
      error: { code: '23514', constraint: 'kb_build_cancel_fence' },
    })
    await waiter.query('ROLLBACK')
    expect((await cancellationState(fixture)).builds).toHaveLength(1)
  }, 'worker')
})

it.each([16, 32])(
  'never recycles orphan physical debt when a new admission waits at limit %s',
  async (limit) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      const operationId = await addCapacityUpload(fixture)
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await observer.query(
        'UPDATE knowledge.kb_quotas SET physical_limit_bytes = $2 WHERE owner_id = $1',
        [fixture.owners[0], limit],
      )
      await cancelCapacityReservation(writer, fixture.id)
      const waiting = reserveInitialCapacity(waiter, {
        ...capacityInput(fixture),
        operationId,
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query('COMMIT')
      await expect(waiting).resolves.toMatchObject(
        limit === 16 ? { error: { code: 'QUOTA_EXCEEDED' } } : { result: { replayed: false } },
      )
      await waiter.query('COMMIT')
      const beforeReplay = await cancellationState(fixture)
      expect(beforeReplay).toMatchObject({
        files: limit === 16 ? '0' : '1',
        physical: limit === 16 ? '16' : '32',
      })
      await capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      )
      expect(await cancellationState(fixture)).toEqual(beforeReplay)
    })
  },
)

it('waits for an in-flight claim and invalidates that newly committed attempt too', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await claimBuild(
      waiter,
      { id: randomUUID(), retryCount: 0 },
      {
        ownerId: fixture.owners[0],
        operationId: fixture.id,
        buildId: randomUUID(),
        receiptId: fixture.id,
      },
      { indexProfileId: fixture.profileId, parserRevision: 'synthetic', parserSnapshot: {} },
    )
    const cancelling = cancelCapacityReservation(writer, fixture.id)
    await expectBlocked(observer, writerPid, waiterPid)
    await waiter.query('COMMIT')
    await expect(cancelling).resolves.toEqual({ replayed: false })
    await writer.query('COMMIT')
    const state = await cancellationState(fixture)
    expect(state.builds).toHaveLength(2)
    expect(state.builds.map((build) => build.status)).toEqual(['invalidated', 'invalidated'])
  }, 'worker')
})

it('waits for a content writer before invalidation and rejects its next append', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await capacityTransaction(
      fixture,
      (transaction) => bindSeedBuild(transaction, fixture),
      fixture.owners[0],
      'worker',
    )
    const context = { ownerId: fixture.owners[0], buildId: fixture.id }
    const chunk = {
      id: randomUUID(),
      ordinal: 1,
      text: 'synthetic',
      textHash: Buffer.alloc(32, 1),
      tokenCount: 1,
      searchVector: '',
    }
    await writeBuildContent(waiter, context, { chunks: [chunk] })
    const cancelling = cancelCapacityReservation(writer, fixture.id)
    await expectBlocked(observer, writerPid, waiterPid)
    await waiter.query('COMMIT')
    await expect(cancelling).resolves.toEqual({ replayed: false })
    await writer.query('COMMIT')
    await waiter.query('BEGIN')
    await waiter.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
    await expect(
      writeBuildContent(waiter, context, {
        chunks: [{ ...chunk, id: randomUUID(), ordinal: 2 }],
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'kb_build_current_attempt',
    })
  }, 'worker')
})
