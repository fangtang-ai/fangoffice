import { expect, it } from 'vitest'
import { reserveInitialCapacity } from '../src/runtime'
import {
  capacityInput,
  capacityState,
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'

it('reserves once and reports an exact replay through the public runtime transaction', async () => {
  await withCapacityFixture(async (fixture) => {
    const input = capacityInput(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) => reserveInitialCapacity(transaction, input)),
    ).resolves.toEqual({ replayed: false })
    await expect(
      capacityTransaction(fixture, (transaction) => reserveInitialCapacity(transaction, input)),
    ).resolves.toEqual({ replayed: true })
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '16',
      reservations: 1,
      desired: fixture.id,
    })
  })
})

it.each(['chunks', 'physicalBytes', 'expiresAt'] as const)(
  'refuses a changed %s on replay without reserving again',
  async (field) => {
    await withCapacityFixture(async (fixture) => {
      const input = capacityInput(fixture)
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, input),
      )
      const before = await capacityState(fixture)
      const changed = {
        ...input,
        [field]:
          field === 'expiresAt' ? new Date(input.expiresAt.getTime() + 1) : input[field] + 1n,
      }
      await expect(
        capacityTransaction(fixture, (transaction) => reserveInitialCapacity(transaction, changed)),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await capacityState(fixture)).toEqual(before)
    })
  },
)

it('rolls back reservation counters and desired pointers with later work failure', async () => {
  await withCapacityFixture(async (fixture) => {
    await expect(
      capacityTransaction(fixture, async (transaction) => {
        await reserveInitialCapacity(transaction, capacityInput(fixture))
        throw new Error('synthetic failure after reservation')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await capacityState(fixture)).toEqual({
      files: '0',
      bytes: '0',
      chunks: '0',
      physical: '0',
      reservations: 0,
      desired: null,
    })
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      ),
    ).resolves.toEqual({ replayed: false })
  })
})

it('does not release or recreate an expired held reservation', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveInitialCapacity(transaction, capacityInput(fixture)),
    )
    await changeCapacityFixture(
      fixture,
      "UPDATE knowledge.kb_reservations SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = $1",
    )
    const before = await capacityState(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await capacityState(fixture)).toEqual(before)
  })
})

it.each(['applied', 'released'] as const)(
  'does not reopen a %s reservation or borrow its capacity',
  async (state) => {
    await withCapacityFixture(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, capacityInput(fixture)),
      )
      await changeCapacityFixture(
        fixture,
        `UPDATE knowledge.kb_reservations SET state = '${state}', closed_at = clock_timestamp() WHERE owner_id = $1`,
      )
      const before = await capacityState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveInitialCapacity(transaction, capacityInput(fixture)),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(await capacityState(fixture)).toEqual(before)
    })
  },
)
