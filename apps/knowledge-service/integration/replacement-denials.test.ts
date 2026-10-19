import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { reserveReplacementCapacity } from '../src/runtime'
import { capacityTransaction, changeCapacityFixture } from './capacity-fixtures'
import {
  addCompetingReplacement,
  replacementInput,
  replacementState,
  withReplacementFixture,
} from './replacement-fixtures'

const denials = [
  [
    'file limit during growth',
    'UPDATE knowledge.kb_quotas SET limit_files = 0 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'byte limit',
    'UPDATE knowledge.kb_quotas SET limit_bytes = 5 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'chunk limit',
    'UPDATE knowledge.kb_quotas SET limit_chunks = 2 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'outstanding logical reservation',
    'UPDATE knowledge.kb_quotas SET reserved_bytes = 1 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'physical debt',
    'UPDATE knowledge.kb_quotas SET physical_accounted_bytes = 1048545 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'outstanding physical reservation',
    'UPDATE knowledge.kb_quotas SET physical_reserved_bytes = 1048481 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'bigint overflow',
    'UPDATE knowledge.kb_quotas SET active_bytes = 9223372036854775807, limit_bytes = 9223372036854775807 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'frozen owner',
    "UPDATE knowledge.kb_quotas SET owner_state = 'frozen' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'frozen space',
    "UPDATE knowledge.kb_spaces SET state = 'frozen' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'stale generation',
    "UPDATE knowledge.kb_operations SET expected_generation = 2 WHERE owner_id = $1 AND kind = 'replace'",
    'VERSION_CONFLICT',
  ],
  [
    'wrong operation kind',
    "UPDATE knowledge.kb_operations SET kind = 'upload' WHERE owner_id = $1 AND kind = 'replace'",
    'FORBIDDEN',
  ],
  [
    'non-queued operation',
    "UPDATE knowledge.kb_operations SET phase = 'indexing' WHERE owner_id = $1 AND kind = 'replace'",
    'FORBIDDEN',
  ],
  [
    'cancelled operation',
    "UPDATE knowledge.kb_operations SET phase = 'cancelled' WHERE owner_id = $1 AND kind = 'replace'",
    'FORBIDDEN',
  ],
  [
    'invalidated base',
    "UPDATE knowledge.kb_builds SET status = 'invalidated' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'base pending GC',
    "UPDATE knowledge.kb_builds SET gc_state = 'pending' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'expired new original',
    "UPDATE knowledge.kb_versions SET retain_until = clock_timestamp() - interval '1 second' WHERE owner_id = $1 AND version_no = 2",
    'FORBIDDEN',
  ],
  [
    'base original pending GC',
    "UPDATE knowledge.kb_versions SET gc_state = 'pending' WHERE owner_id = $1 AND version_no = 1",
    'FORBIDDEN',
  ],
  [
    'inconsistent active bytes',
    'UPDATE knowledge.kb_quotas SET active_bytes = 3 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'inconsistent active chunks',
    'UPDATE knowledge.kb_quotas SET active_chunks = 0 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'inconsistent active files',
    'UPDATE knowledge.kb_quotas SET active_files = 0 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'unconfigured policy',
    'UPDATE knowledge.kb_quotas SET policy_revision = NULL, limit_files = NULL, limit_bytes = NULL, limit_chunks = NULL WHERE owner_id = $1',
    'NOT_CONFIGURED',
  ],
] as const

it.each(denials)(
  'rejects %s without partial replacement writes',
  async (_name, statement, code) => {
    await withReplacementFixture(async (fixture) => {
      await changeCapacityFixture(fixture, statement)
      const before = await replacementState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, replacementInput(fixture)),
        ),
      ).rejects.toMatchObject({ code })
      expect(await replacementState(fixture)).toEqual(before)
    })
  },
)

it.each([false, true])(
  'does not lend the old base twice when its earlier held reservation is expired=%s',
  async (expired) => {
    await withReplacementFixture(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, replacementInput(fixture)),
      )
      if (expired)
        await changeCapacityFixture(
          fixture,
          "UPDATE knowledge.kb_reservations SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = $1",
        )
      const operationId = await addCompetingReplacement(fixture)
      const before = await replacementState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, { ...replacementInput(fixture), operationId }),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await replacementState(fixture)).toEqual(before)
    })
  },
)

it('hides a real other-owner replacement just like a missing operation', async () => {
  await withReplacementFixture(async (fixture) => {
    for (const operationId of [fixture.replacementId, randomUUID()])
      await expect(
        capacityTransaction(
          fixture,
          (transaction) =>
            reserveReplacementCapacity(transaction, { ...replacementInput(fixture), operationId }),
          fixture.owners[1],
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

it('keeps the physical hard limit for non-growth remediation after downgrade', async () => {
  await withReplacementFixture(
    async (fixture) => {
      await changeCapacityFixture(
        fixture,
        'UPDATE knowledge.kb_quotas SET limit_files = 0, limit_bytes = 0, limit_chunks = 0, physical_accounted_bytes = 1048545 WHERE owner_id = $1',
      )
      const before = await replacementState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveReplacementCapacity(transaction, { ...replacementInput(fixture), chunks: 0n }),
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
      expect(await replacementState(fixture)).toEqual(before)
    },
    { versionBytes: 2n },
  )
})

it.each([
  { chunks: -1n },
  { chunks: 9223372036854775808n },
  { physicalBytes: 5n },
  { expiresAt: new Date(0) },
  { operationId: 'invalid' },
])('rejects invalid replacement input %s', async (change) => {
  await withReplacementFixture(async (fixture) => {
    const before = await replacementState(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, { ...replacementInput(fixture), ...change }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await replacementState(fixture)).toEqual(before)
  })
})
