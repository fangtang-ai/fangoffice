import { expect, it, vi } from 'vitest'
import {
  cancelCapacityReservation,
  reserveInitialCapacity,
  reserveRetryCapacity,
} from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { cancellationState } from './cancellation-fixtures'
import {
  addCapacityUpload,
  capacityInput,
  capacityState,
  capacityTransaction,
  changeCapacityFixture,
} from './capacity-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { addFollowupUpload } from './retry-fixtures'

it('keeps late old cancellation replay from withdrawing a newly committed retry', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await capacityTransaction(fixture, async (transaction) => {
      await reserveInitialCapacity(transaction, capacityInput(fixture))
      await cancelCapacityReservation(transaction, fixture.id)
    })
    const operationId = await addFollowupUpload(fixture)
    await reserveRetryCapacity(writer, { ...capacityInput(fixture), operationId })
    const waiting = cancelCapacityReservation(waiter, fixture.id)
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('COMMIT')
    await expect(waiting).resolves.toEqual({ replayed: true })
    await waiter.query('COMMIT')
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '32',
      reservations: 2,
      desired: operationId,
    })
  })
})

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes duplicate retry admission after %s without double charging',
  async (outcome) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      await capacityTransaction(fixture, async (transaction) => {
        await reserveInitialCapacity(transaction, capacityInput(fixture))
        await cancelCapacityReservation(transaction, fixture.id)
      })
      const operationId = await addFollowupUpload(fixture)
      const input = { ...capacityInput(fixture), operationId }
      await reserveRetryCapacity(writer, input)
      const waiting = reserveRetryCapacity(waiter, input)
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query(outcome)
      await expect(waiting).resolves.toEqual({ replayed: outcome === 'COMMIT' })
      await waiter.query('COMMIT')
      expect(await capacityState(fixture)).toEqual({
        files: '1',
        bytes: '4',
        chunks: '1',
        physical: '32',
        reservations: 2,
        desired: operationId,
      })
    })
  },
)

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'admits retry only if the pending predecessor cancellation chooses %s',
  async (outcome) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await changeCapacityFixture(
        fixture,
        "UPDATE knowledge.kb_operations SET phase = 'cancelled' WHERE owner_id = $1 AND id = $2",
        [fixture.id],
      )
      const operationId = await addFollowupUpload(fixture)
      await cancelCapacityReservation(writer, fixture.id)
      const waiting = reserveRetryCapacity(waiter, { ...capacityInput(fixture), operationId }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query(outcome)
      await expect(waiting).resolves.toMatchObject(
        outcome === 'COMMIT'
          ? { result: { replayed: false } }
          : { error: { code: 'VERSION_CONFLICT' } },
      )
      await waiter.query('COMMIT')
      expect(await capacityState(fixture)).toMatchObject({
        physical: outcome === 'COMMIT' ? '32' : '16',
        desired: outcome === 'COMMIT' ? operationId : fixture.id,
        reservations: outcome === 'COMMIT' ? 2 : 1,
      })
    })
  },
)

it('does not re-admit a retry waiting behind its own cancellation', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await capacityTransaction(fixture, async (transaction) => {
      await reserveInitialCapacity(transaction, capacityInput(fixture))
      await cancelCapacityReservation(transaction, fixture.id)
    })
    const operationId = await addFollowupUpload(fixture)
    const input = { ...capacityInput(fixture), operationId }
    await capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, input))
    await cancelCapacityReservation(writer, operationId)
    const waiting = reserveRetryCapacity(waiter, input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('COMMIT')
    await expect(waiting).resolves.toMatchObject({ error: { code: 'VERSION_CONFLICT' } })
    await waiter.query('COMMIT')
    expect(await cancellationState(fixture, operationId)).toMatchObject({
      generation: '2',
      state: 'released',
      files: '0',
      physical: '32',
      desired: null,
    })
  })
})

it('rejects an expiry that passes while waiting for the quota lock', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await capacityTransaction(fixture, async (transaction) => {
      await reserveInitialCapacity(transaction, capacityInput(fixture))
      await cancelCapacityReservation(transaction, fixture.id)
    })
    const operationId = await addFollowupUpload(fixture)
    await cancelCapacityReservation(writer, fixture.id)
    const expiresAt = new Date(Date.now() + 800)
    const waiting = reserveRetryCapacity(waiter, {
      ...capacityInput(fixture),
      operationId,
      expiresAt,
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await expectBlocked(observer, waiterPid, writerPid)
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(expiresAt.getTime()), {
      timeout: 2000,
      interval: 20,
    })
    await writer.query('COMMIT')
    await expect(waiting).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    await waiter.query('COMMIT')
    expect(await capacityState(fixture)).toMatchObject({
      files: '0',
      physical: '16',
      reservations: 1,
      desired: null,
    })
  })
})

it('serializes retry against unrelated admission at the physical hard limit', async () => {
  await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
    await capacityTransaction(fixture, async (transaction) => {
      await reserveInitialCapacity(transaction, capacityInput(fixture))
      await cancelCapacityReservation(transaction, fixture.id)
    })
    const operationId = await addFollowupUpload(fixture)
    const competingId = await addCapacityUpload(fixture)
    await changeCapacityFixture(
      fixture,
      'UPDATE knowledge.kb_quotas SET limit_files = 2, limit_bytes = 8, limit_chunks = 2, physical_limit_bytes = 32 WHERE owner_id = $1',
    )
    await reserveRetryCapacity(writer, { ...capacityInput(fixture), operationId })
    const waiting = reserveInitialCapacity(waiter, {
      ...capacityInput(fixture),
      operationId: competingId,
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    await expectBlocked(observer, waiterPid, writerPid)
    await writer.query('COMMIT')
    await expect(waiting).resolves.toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } })
    await waiter.query('COMMIT')
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '32',
      reservations: 2,
      desired: operationId,
    })
  })
})
