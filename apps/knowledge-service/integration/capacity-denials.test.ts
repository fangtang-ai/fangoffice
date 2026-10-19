import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { reserveInitialCapacity } from '../src/runtime'
import {
  addCapacityUpload,
  capacityInput,
  capacityState,
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'

const denials = [
  [
    'file limit',
    'UPDATE knowledge.kb_quotas SET limit_files = 0 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'byte limit',
    'UPDATE knowledge.kb_quotas SET limit_bytes = 3 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'chunk limit',
    'UPDATE knowledge.kb_quotas SET limit_chunks = 0 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'active files',
    'UPDATE knowledge.kb_quotas SET active_files = 1 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'active bytes',
    'UPDATE knowledge.kb_quotas SET active_bytes = 1 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'active chunks',
    'UPDATE knowledge.kb_quotas SET active_chunks = 1 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'physical debt',
    'UPDATE knowledge.kb_quotas SET physical_accounted_bytes = 1048561 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'physical reservation debt',
    'UPDATE knowledge.kb_quotas SET physical_reserved_bytes = 1048561 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'bigint sum overflow',
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
    'deleted document',
    'UPDATE knowledge.kb_documents SET deleted_at = clock_timestamp() WHERE owner_id = $1',
    'FORBIDDEN',
  ],
  [
    'stale generation',
    'UPDATE knowledge.kb_operations SET expected_generation = 1 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'replacement',
    "UPDATE knowledge.kb_operations SET kind = 'replace' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'cancelled operation',
    "UPDATE knowledge.kb_operations SET phase = 'cancelled' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'original pending GC',
    "UPDATE knowledge.kb_versions SET gc_state = 'pending' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'original retention expired',
    "UPDATE knowledge.kb_versions SET retain_until = clock_timestamp() - interval '1 second' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'missing policy',
    'UPDATE knowledge.kb_quotas SET policy_revision = NULL, limit_files = NULL, limit_bytes = NULL, limit_chunks = NULL WHERE owner_id = $1',
    'NOT_CONFIGURED',
  ],
] as const

it.each(denials)(
  'rejects %s without partial reservation or admission',
  async (_name, statement, code) => {
    await withCapacityFixture(async (fixture) => {
      await changeCapacityFixture(fixture, statement)
      const before = await capacityState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveInitialCapacity(transaction, capacityInput(fixture)),
        ),
      ).rejects.toMatchObject({ code })
      expect(await capacityState(fixture)).toEqual(before)
    })
  },
)

it('hides a real other-owner operation just like an absent operation', async () => {
  await withCapacityFixture(async (fixture) => {
    const operationId = await addCapacityUpload(fixture)
    for (const target of [operationId, randomUUID()])
      await expect(
        capacityTransaction(
          fixture,
          (transaction) =>
            reserveInitialCapacity(transaction, { ...capacityInput(fixture), operationId: target }),
          fixture.owners[1],
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

it.each([
  { operationId: 'invalid' },
  { chunks: -1n },
  { chunks: 9223372036854775808n },
  { physicalBytes: 0n },
  { physicalBytes: 9223372036854775808n },
  { expiresAt: new Date('invalid') },
  { expiresAt: new Date(0) },
])('rejects invalid capacity input %s', async (change) => {
  await withCapacityFixture(async (fixture) => {
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveInitialCapacity(transaction, { ...capacityInput(fixture), ...change }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await capacityState(fixture))?.reservations).toBe(0)
  })
})
