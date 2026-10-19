import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { publishBuild } from '../src/runtime'
import { changeCapacityFixture } from './capacity-fixtures'
import {
  publicationState,
  publicationTransaction,
  withPublicationFixture,
} from './publication-fixtures'

const mutations = [
  ["UPDATE knowledge.kb_quotas SET owner_state = 'frozen' WHERE owner_id = $1", 'FORBIDDEN'],
  ["UPDATE knowledge.kb_spaces SET state = 'frozen' WHERE owner_id = $1", 'FORBIDDEN'],
  [
    'UPDATE knowledge.kb_documents SET deleted_at = now(), desired_operation_id = NULL, desired_version_id = NULL WHERE owner_id = $1',
    'FORBIDDEN',
  ],
  [
    'UPDATE knowledge.kb_documents SET desired_operation_id = NULL, desired_version_id = NULL WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    "UPDATE knowledge.kb_operations SET phase = 'failed', error_code = 'SYNTHETIC' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  ["UPDATE knowledge.kb_builds SET status = 'invalidated' WHERE owner_id = $1", 'FORBIDDEN'],
  [
    "UPDATE knowledge.kb_reservations SET expires_at = now() - interval '1 second' WHERE owner_id = $1",
    'FORBIDDEN',
  ],
  [
    'UPDATE knowledge.kb_quotas SET policy_revision = NULL, limit_files = NULL, limit_bytes = NULL, limit_chunks = NULL WHERE owner_id = $1',
    'NOT_CONFIGURED',
  ],
  ['UPDATE knowledge.kb_quotas SET limit_bytes = 3 WHERE owner_id = $1', 'QUOTA_EXCEEDED'],
  ['UPDATE knowledge.kb_quotas SET reserved_bytes = 0 WHERE owner_id = $1', 'VERSION_CONFLICT'],
  [
    'UPDATE knowledge.kb_quotas SET physical_reserved_bytes = 0 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  ['UPDATE knowledge.kb_quotas SET active_bytes = 1 WHERE owner_id = $1', 'QUOTA_EXCEEDED'],
  [
    'UPDATE knowledge.kb_quotas SET active_bytes = 1, limit_bytes = 100 WHERE owner_id = $1',
    'VERSION_CONFLICT',
  ],
  [
    'UPDATE knowledge.kb_quotas SET physical_limit_bytes = 15 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  [
    'UPDATE knowledge.kb_reservations SET projected_chunks = 0 WHERE owner_id = $1',
    'QUOTA_EXCEEDED',
  ],
  ['DELETE FROM knowledge.kb_reservations WHERE owner_id = $1', 'NOT_FOUND'],
] as const

it.each(mutations)('rejects %s without partial publication (%s)', async (statement, code) => {
  await withPublicationFixture(async (fixture) => {
    await changeCapacityFixture(fixture, statement)
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context)),
    ).rejects.toMatchObject({ code })
    expect(await publicationState(fixture)).toEqual(before)
  })
})

it.each(['documentId', 'operationId', 'versionId', 'buildId', 'indexProfileId'] as const)(
  'hides a mismatched %s without capacity changes',
  async (key) => {
    await withPublicationFixture(async (fixture) => {
      const before = await publicationState(fixture)
      await expect(
        publicationTransaction(fixture, (transaction) =>
          publishBuild(transaction, {
            ...fixture.context,
            [key]: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(await publicationState(fixture)).toEqual(before)
    })
  },
)

it('hides another owner even when both tenants use the same row IDs', async () => {
  await withPublicationFixture(async (fixture) => {
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) =>
        publishBuild(transaction, {
          ...fixture.context,
          ownerId: fixture.owners[1],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await publicationState(fixture)).toEqual(before)
  })
})

it.each([
  { sequence: '9223372036854775807', after: '0', collision: false },
  { sequence: '1', after: '1', collision: false },
  { sequence: '1', after: '0', collision: true },
])('refuses broken or conflicting storage history %j', async ({ sequence, after, collision }) => {
  await withPublicationFixture(async (fixture) => {
    await changeCapacityFixture(
      fixture,
      `INSERT INTO knowledge.kb_metering_events
      (owner_id, id, logical_event_key, event_type, dimension, unit, quantity, usage_source,
       subject_kind, subject_key, sequence, active_bytes_before, active_bytes_after, payer, occurred_at)
      VALUES ($1, CASE WHEN $5::boolean THEN $2::uuid ELSE gen_random_uuid() END,
        'synthetic-conflict', 'capacity_change', 'storage', 'bytes', $4::bigint, 'reconciled',
        'capacity_change', 'synthetic-conflict', $3::bigint, 0, $4::bigint, 'platform', now())`,
      [fixture.id, sequence, after, collision],
    )
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await publicationState(fixture)).toEqual(before)
  })
})
