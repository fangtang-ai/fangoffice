import { expect, it } from 'vitest'
import { withReplacementFixture } from './replacement-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it('reserves only positive replacement deltas while retaining the old active build and full physical debt', async () => {
  await withReplacementFixture(async (fixture) => {
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            'SELECT knowledge.reserve_replacement_capacity($1, 3, 32, $2) AS status',
            [fixture.replacementId, fixture.expiresAt],
          )
        ).rows,
      ).toEqual([{ status: 'RESERVED' }])
      expect(
        (
          await client.query(
            `SELECT reserved_files::text AS files, reserved_bytes::text AS bytes,
                reserved_chunks::text AS chunks, physical_reserved_bytes::text AS physical,
                base_version_id::text AS version, base_build_id::text AS build,
                expected_generation::text AS generation, projected_chunks::text AS projected
         FROM knowledge.kb_reservations WHERE owner_id = $1 AND operation_id = $2`,
            [fixture.owners[0], fixture.replacementId],
          )
        ).rows,
      ).toEqual([
        {
          files: '0',
          bytes: '2',
          chunks: '2',
          physical: '32',
          version: fixture.id,
          build: fixture.id,
          generation: '1',
          projected: '3',
        },
      ])
      expect(
        (
          await client.query(
            `SELECT active_files::text AS files, active_bytes::text AS bytes, active_chunks::text AS chunks,
                reserved_files::text AS reserved_files, reserved_bytes::text AS reserved_bytes,
                reserved_chunks::text AS reserved_chunks, physical_accounted_bytes::text AS accounted,
                physical_reserved_bytes::text AS physical FROM knowledge.kb_quotas WHERE owner_id = $1`,
            [fixture.owners[0]],
          )
        ).rows,
      ).toEqual([
        {
          files: '1',
          bytes: '4',
          chunks: '1',
          reserved_files: '0',
          reserved_bytes: '2',
          reserved_chunks: '2',
          accounted: '64',
          physical: '32',
        },
      ])
      expect(
        (
          await client.query(
            `SELECT active_build_id::text AS active, generation::text AS generation,
                desired_operation_id::text AS desired, desired_version_id::text AS version
         FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2`,
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([
        {
          active: fixture.id,
          generation: '1',
          desired: fixture.replacementId,
          version: fixture.replacementId,
        },
      ])
    })
  })
})
