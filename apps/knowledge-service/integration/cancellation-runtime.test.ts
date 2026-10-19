import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  reserveInitialCapacity,
  reserveReplacementCapacity,
} from '../src/runtime'
import { cancellationState } from './cancellation-fixtures'
import {
  capacityInput,
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'
import { replacementInput, withReplacementFixture } from './replacement-fixtures'

it('cancels once and reports a replay without releasing physical debt through the public runtime', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await expect(
      capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      ),
    ).resolves.toEqual({ replayed: false })
    const cancelled = await cancellationState(fixture)
    expect(cancelled).toMatchObject({
      generation: '1',
      desired: null,
      desired_version: null,
      active_build: null,
      phase: 'cancelled',
      state: 'released',
      closed: true,
      files: '0',
      bytes: '0',
      chunks: '0',
      physical: '16',
      accounted: '0',
      builds: [{ id: fixture.id, status: 'invalidated', gc_state: 'live' }],
    })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      ),
    ).resolves.toEqual({ replayed: true })
    expect(await cancellationState(fixture)).toEqual(cancelled)
  })
})

it('cancels a replacement without changing the old active version or its physical account', async () => {
  await withReplacementFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveReplacementCapacity(transaction, replacementInput(fixture)),
    )
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.replacementId),
    )
    expect(await cancellationState(fixture, fixture.replacementId)).toMatchObject({
      generation: '2',
      desired: null,
      desired_version: null,
      active_build: fixture.id,
      active_version: fixture.id,
      active_files: '1',
      active_bytes: '4',
      active_chunks: '1',
      phase: 'cancelled',
      state: 'released',
      closed: true,
      files: '0',
      bytes: '0',
      chunks: '0',
      physical: '32',
      accounted: '64',
    })
  })
})

it('rolls back counters, cancellation, generation and writer invalidation with later work failure', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    const before = await cancellationState(fixture)
    await expect(
      capacityTransaction(fixture, async (transaction) => {
        await cancelCapacityReservation(transaction, fixture.id)
        throw new Error('synthetic failure after cancellation')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await cancellationState(fixture)).toEqual(before)
  })
})

it('explicitly cancels expired debt even after the owner and space are frozen', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_reservations
      SET expires_at = now() - interval '1 second' WHERE owner_id = $1`,
    )
    await changeCapacityFixture(
      fixture,
      "UPDATE knowledge.kb_quotas SET owner_state = 'frozen' WHERE owner_id = $1",
    )
    await changeCapacityFixture(
      fixture,
      "UPDATE knowledge.kb_spaces SET state = 'frozen' WHERE owner_id = $1",
    )
    await expect(
      capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      ),
    ).resolves.toEqual({ replayed: false })
    expect(await cancellationState(fixture)).toMatchObject({ state: 'released', physical: '16' })
  })
})

it('replays an old cancellation without clearing a newer desired operation', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.id),
    )
    const successor = randomUUID()
    await changeCapacityFixture(
      fixture,
      `INSERT INTO knowledge.kb_operations
      (owner_id, id, document_id, idempotency_key, request_hash, kind, phase, target_version_id, expected_generation)
      VALUES ($1, $2::uuid, $3, $2::uuid::text, decode(repeat('ef', 32), 'hex'), 'upload', 'queued', $3, 1)`,
      [successor, fixture.id],
    )
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_documents
      SET desired_operation_id = $2, desired_version_id = $3 WHERE owner_id = $1 AND id = $3`,
      [successor, fixture.id],
    )
    const before = await cancellationState(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        cancelCapacityReservation(transaction, fixture.id),
      ),
    ).resolves.toEqual({ replayed: true })
    expect(await cancellationState(fixture)).toEqual(before)
    expect(before.desired).toBe(successor)
  })
})

it.each([
  [
    'stale generation',
    'UPDATE knowledge.kb_operations SET expected_generation = 1 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'withdrawn intent',
    'UPDATE knowledge.kb_documents SET desired_operation_id = NULL, desired_version_id = NULL WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'insufficient counter',
    'UPDATE knowledge.kb_quotas SET reserved_bytes = 0 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'applied reservation',
    "UPDATE knowledge.kb_reservations SET state = 'applied', closed_at = now() WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'publication window',
    "UPDATE knowledge.kb_operations SET phase = 'publishing' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'published operation',
    "UPDATE knowledge.kb_operations SET phase = 'ready' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
] as const)(
  'refuses %s without changing any remaining debt or writer',
  async (_label, statement, code) => {
    await withCapacityFixture(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await changeCapacityFixture(fixture, statement)
      const before = await cancellationState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          cancelCapacityReservation(transaction, fixture.id),
        ),
      ).rejects.toMatchObject({ code })
      expect(await cancellationState(fixture)).toEqual(before)
    })
  },
)
