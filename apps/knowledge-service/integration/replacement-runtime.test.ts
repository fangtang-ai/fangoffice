import { expect, it } from 'vitest'
import { reserveReplacementCapacity } from '../src/runtime'
import { capacityState, capacityTransaction, changeCapacityFixture } from './capacity-fixtures'
import { replacementInput, replacementState, withReplacementFixture } from './replacement-fixtures'

it('reserves and exactly replays through the public replacement runtime transaction', async () => {
  await withReplacementFixture(async (fixture) => {
    const input = replacementInput(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) => reserveReplacementCapacity(transaction, input)),
    ).resolves.toEqual({ replayed: false })
    await expect(
      capacityTransaction(fixture, (transaction) => reserveReplacementCapacity(transaction, input)),
    ).resolves.toEqual({ replayed: true })
    expect(await capacityState(fixture)).toEqual({
      files: '0',
      bytes: '2',
      chunks: '2',
      physical: '32',
      reservations: 1,
      desired: fixture.replacementId,
    })
  })
})

it('rejects changed projected chunks even when both requests reserve zero incremental chunks', async () => {
  await withReplacementFixture(async (fixture) => {
    const input = { ...replacementInput(fixture), chunks: 0n }
    await capacityTransaction(fixture, (transaction) =>
      reserveReplacementCapacity(transaction, input),
    )
    const before = await replacementState(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, { ...input, chunks: 1n }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await replacementState(fixture)).toEqual(before)
  })
})

it.each(['physicalBytes', 'expiresAt'] as const)(
  'rejects changed %s without replacing held facts',
  async (field) => {
    await withReplacementFixture(async (fixture) => {
      const input = replacementInput(fixture)
      await capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, input),
      )
      const before = await replacementState(fixture)
      const changed = {
        ...input,
        [field]:
          field === 'expiresAt'
            ? new Date(input.expiresAt.getTime() + 1)
            : input.physicalBytes + 1n,
      }
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, changed),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await replacementState(fixture)).toEqual(before)
    })
  },
)

it('rolls back quota, reservation and desired writes when later transaction work fails', async () => {
  await withReplacementFixture(async (fixture) => {
    const before = await replacementState(fixture)
    await expect(
      capacityTransaction(fixture, async (transaction) => {
        await reserveReplacementCapacity(transaction, replacementInput(fixture))
        throw new Error('synthetic failure after replacement admission')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await replacementState(fixture)).toEqual(before)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, replacementInput(fixture)),
      ),
    ).resolves.toEqual({ replayed: false })
  })
})

it('admits all-dimension non-growth remediation after downgrade without releasing old active debt', async () => {
  await withReplacementFixture(
    async (fixture) => {
      await changeCapacityFixture(
        fixture,
        'UPDATE knowledge.kb_quotas SET limit_files = 0, limit_bytes = 0, limit_chunks = 0 WHERE owner_id = $1',
      )
      const input = { ...replacementInput(fixture), chunks: 0n }
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, input),
        ),
      ).resolves.toEqual({ replayed: false })
      expect(await capacityState(fixture)).toEqual({
        files: '0',
        bytes: '0',
        chunks: '0',
        physical: '32',
        reservations: 1,
        desired: fixture.replacementId,
      })
    },
    { versionBytes: 2n },
  )
})

it.each(['held', 'applied', 'released'] as const)(
  'never reopens or clears an expired/closed %s reservation',
  async (state) => {
    await withReplacementFixture(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, replacementInput(fixture)),
      )
      await changeCapacityFixture(
        fixture,
        state === 'held'
          ? "UPDATE knowledge.kb_reservations SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = $1"
          : `UPDATE knowledge.kb_reservations SET state = '${state}', closed_at = clock_timestamp() WHERE owner_id = $1`,
      )
      const before = await replacementState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, replacementInput(fixture)),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(await replacementState(fixture)).toEqual(before)
    })
  },
)
