import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { reserveRetryCapacity } from '../src/runtime'
import {
  capacityInput,
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'
import { retryState, withRetryFixture } from './retry-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

const denials = [
  ['files', 'UPDATE knowledge.kb_quotas SET limit_files = 0 WHERE owner_id = $1', 'QUOTA_EXCEEDED'],
  ['bytes', 'UPDATE knowledge.kb_quotas SET limit_bytes = 3 WHERE owner_id = $1', 'QUOTA_EXCEEDED'],
  [
    'chunks',
    'UPDATE knowledge.kb_quotas SET limit_chunks = 0 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'physical debt',
    'UPDATE knowledge.kb_quotas SET physical_limit_bytes = 31 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'accounted debt',
    'UPDATE knowledge.kb_quotas SET physical_accounted_bytes = 1048545 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'bigint sum',
    'UPDATE knowledge.kb_quotas SET physical_reserved_bytes = 9223372036854775807, physical_limit_bytes = 9223372036854775807 WHERE owner_id = $1',
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
    'old generation',
    'UPDATE knowledge.kb_operations SET expected_generation = 0 WHERE owner_id = $1 AND id = $2',
    'VERSION_CONFLICT',
  ],
  [
    'future generation',
    'UPDATE knowledge.kb_operations SET expected_generation = 2 WHERE owner_id = $1 AND id = $2',
    'VERSION_CONFLICT',
  ],
  [
    'not queued',
    "UPDATE knowledge.kb_operations SET phase = 'indexing' WHERE owner_id = $1 AND id = $2",
    'FORBIDDEN',
  ],
  [
    'replacement kind',
    "UPDATE knowledge.kb_operations SET kind = 'replace' WHERE owner_id = $1 AND id = $2",
    'FORBIDDEN',
  ],
  [
    'old source reuse',
    'UPDATE knowledge.kb_operations SET target_version_id = $3 WHERE owner_id = $1 AND id = $2',
    'FORBIDDEN',
  ],
  [
    'pending original',
    "UPDATE knowledge.kb_versions SET gc_state = 'pending' WHERE owner_id = $1 AND id = $2",
    'FORBIDDEN',
  ],
  [
    'expired original',
    "UPDATE knowledge.kb_versions SET retain_until = clock_timestamp() - interval '1 second' WHERE owner_id = $1 AND id = $2",
    'FORBIDDEN',
  ],
  [
    'unreleased predecessor',
    "UPDATE knowledge.kb_reservations SET state = 'held', closed_at = NULL WHERE owner_id = $1 AND operation_id <> $2",
    'VERSION_CONFLICT',
  ],
  [
    'missing predecessor',
    'DELETE FROM knowledge.kb_reservations WHERE owner_id = $1 AND operation_id <> $2',
    'VERSION_CONFLICT',
  ],
  [
    'stale predecessor',
    'UPDATE knowledge.kb_reservations SET expected_generation = 1 WHERE owner_id = $1 AND operation_id <> $2',
    'VERSION_CONFLICT',
  ],
  [
    'missing policy',
    'UPDATE knowledge.kb_quotas SET policy_revision = NULL, limit_files = NULL, limit_bytes = NULL, limit_chunks = NULL WHERE owner_id = $1',
    'NOT_CONFIGURED',
  ],
] as const

it.each(denials)(
  'rejects retry with %s and changes no admission facts',
  async (_label, statement, code) => {
    await withRetryFixture(async (fixture) => {
      // 每条语句仅绑定其占位参数，避免把夹具参数数量错误误当作业务拒绝。
      const values = statement.includes('$3')
        ? [fixture.retryId, fixture.id]
        : statement.includes('$2')
          ? [fixture.retryId]
          : []
      await changeCapacityFixture(fixture, statement, values)
      const before = await retryState(fixture)
      await expect(
        capacityTransaction(fixture, (transaction) =>
          reserveRetryCapacity(transaction, {
            ...capacityInput(fixture),
            operationId: fixture.retryId,
          }),
        ),
      ).rejects.toMatchObject({ code })
      expect(await retryState(fixture)).toEqual(before)
    })
  },
)

it('does not treat a generation-zero first upload or the old cancelled operation as a retry', async () => {
  await withCapacityFixture(async (fixture) => {
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveRetryCapacity(transaction, capacityInput(fixture)),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
  await withRetryFixture(async (fixture) => {
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveRetryCapacity(transaction, capacityInput(fixture)),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

it('hides other-owner retries exactly like nonexistent operations', async () => {
  await withRetryFixture(async (fixture) => {
    const before = await retryState(fixture)
    for (const operationId of [fixture.retryId, randomUUID()])
      await expect(
        capacityTransaction(
          fixture,
          (transaction) =>
            reserveRetryCapacity(transaction, {
              ...capacityInput(fixture),
              operationId,
            }),
          fixture.owners[1],
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await retryState(fixture)).toEqual(before)
  })
})

it.each([
  [null, '1', '16', '2099-01-01T00:00:00Z'],
  [randomUUID(), null, '16', '2099-01-01T00:00:00Z'],
  [randomUUID(), '-1', '16', '2099-01-01T00:00:00Z'],
  [randomUUID(), '1', '-1', '2099-01-01T00:00:00Z'],
  [randomUUID(), '1', null, '2099-01-01T00:00:00Z'],
  [randomUUID(), '1', '16', null],
  [randomUUID(), '1', '16', 'infinity'],
  [randomUUID(), '1', '16', '1970-01-01T00:00:00Z'],
])('refuses invalid SQL retry inputs %j', async (operationId, chunks, physical, expiry) => {
  await withRetryFixture(async (fixture) => {
    const before = await retryState(fixture)
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query('SELECT knowledge.reserve_retry_capacity($1, $2, $3, $4) AS status', [
            operationId,
            chunks,
            physical,
            expiry,
          ])
        ).rows,
      ).toEqual([{ status: 'INVALID_REQUEST' }])
    })
    expect(await retryState(fixture)).toEqual(before)
  })
})
