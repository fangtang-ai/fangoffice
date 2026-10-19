import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  reserveInitialCapacity,
  reserveReplacementCapacity,
  reserveRetryCapacity,
} from '../src/runtime'
import {
  capacityInput,
  capacityState,
  capacityTransaction,
  changeCapacityFixture,
} from './capacity-fixtures'
import { cancellationState } from './cancellation-fixtures'
import { replacementInput, withReplacementFixture } from './replacement-fixtures'
import { addFollowupUpload, retryState, withRetryFixture } from './retry-fixtures'

it('exposes explicit retry admission and exact replay through the public runtime', async () => {
  await withRetryFixture(async (fixture) => {
    const input = { ...capacityInput(fixture), operationId: fixture.retryId }
    for (const replayed of [false, true])
      await expect(
        capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, input)),
      ).resolves.toEqual({ replayed })
    expect(await capacityState(fixture)).toMatchObject({
      physical: '32',
      reservations: 2,
      desired: fixture.retryId,
    })
  })
})

it('refuses a retry physical projection smaller than its verified original', async () => {
  await withRetryFixture(async (fixture) => {
    const before = await retryState(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveRetryCapacity(transaction, {
          ...capacityInput(fixture),
          operationId: fixture.retryId,
          physicalBytes: 3n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await retryState(fixture)).toEqual(before)
  })
})

it('rolls back retry counters, reservation and desired pointers when later work fails', async () => {
  await withRetryFixture(async (fixture) => {
    const input = { ...capacityInput(fixture), operationId: fixture.retryId }
    const before = await retryState(fixture)
    await expect(
      capacityTransaction(fixture, async (transaction) => {
        await reserveRetryCapacity(transaction, input)
        throw new Error('synthetic failure after retry admission')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await retryState(fixture)).toEqual(before)
    await expect(
      capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, input)),
    ).resolves.toEqual({ replayed: false })
  })
})

it('keeps old cancellation replay harmless and supports another explicit cancellation/retry cycle', async () => {
  await withRetryFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveRetryCapacity(transaction, {
        ...capacityInput(fixture),
        operationId: fixture.retryId,
      }),
    )
    const before = await retryState(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      ),
    ).resolves.toEqual({ replayed: true })
    expect(await retryState(fixture)).toEqual(before)
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.retryId),
    )
    const operationId = await addFollowupUpload(fixture, { generation: 2n })
    await capacityTransaction(fixture, (transaction) =>
      reserveRetryCapacity(transaction, {
        ...capacityInput(fixture),
        operationId,
      }),
    )
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '48',
      reservations: 3,
      desired: operationId,
    })
    expect(await cancellationState(fixture, operationId)).toMatchObject({
      generation: '2',
      state: 'held',
    })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, {
          ...capacityInput(fixture),
          operationId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

it.each(['chunks', 'physicalBytes', 'expiresAt'] as const)(
  'rejects changed retry %s without reserving again',
  async (field) => {
    await withRetryFixture(async (fixture) => {
      const input = { ...capacityInput(fixture), operationId: fixture.retryId }
      await capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, input))
      const before = await retryState(fixture)
      const changed = {
        ...input,
        [field]:
          field === 'expiresAt' ? new Date(input.expiresAt.getTime() + 1) : input[field] + 1n,
      }
      await expect(
        capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, changed)),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await retryState(fixture)).toEqual(before)
    })
  },
)

it.each(['held', 'applied', 'released'] as const)(
  'cannot renew expired or reopen %s retry debt',
  async (state) => {
    await withRetryFixture(async (fixture) => {
      const input = { ...capacityInput(fixture), operationId: fixture.retryId }
      await capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, input))
      await changeCapacityFixture(
        fixture,
        `UPDATE knowledge.kb_reservations SET state = $3, expires_at = clock_timestamp() - interval '1 second',
        closed_at = CASE WHEN $3 = 'held' THEN NULL ELSE clock_timestamp() END
       WHERE owner_id = $1 AND operation_id = $2`,
        [fixture.retryId, state],
      )
      const before = await retryState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, input)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(await retryState(fixture)).toEqual(before)
    })
  },
)

it('retries a cancelled replacement through existing base-credit admission without touching active data', async () => {
  await withReplacementFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveReplacementCapacity(transaction, replacementInput(fixture)),
    )
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.replacementId),
    )
    const operationId = await addFollowupUpload(fixture, { generation: 2n, kind: 'replace' })
    const input = { ...replacementInput(fixture), operationId }
    await expect(
      capacityTransaction(fixture, (transaction) => reserveRetryCapacity(transaction, input)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    for (const replayed of [false, true])
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, input),
        ),
      ).resolves.toEqual({ replayed })
    expect(await cancellationState(fixture, operationId)).toMatchObject({
      generation: '2',
      active_version: fixture.id,
      active_build: fixture.id,
      active_files: '1',
      active_bytes: '4',
      active_chunks: '1',
      files: '0',
      bytes: '0',
      chunks: '2',
      physical: '64',
      accounted: '64',
      desired: operationId,
      state: 'held',
    })
  })
})
