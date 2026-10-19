import { expect, it } from 'vitest'
import { withCapacityFixture } from './capacity-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it('atomically reserves initial-upload capacity and admits the desired pair through the API role', async () => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      const result = await client.query<{ status: string }>(
        'SELECT knowledge.reserve_initial_capacity($1, $2, $3, $4) AS status',
        [fixture.id, '1', '16', fixture.expiresAt],
      )
      expect(result.rows).toEqual([{ status: 'RESERVED' }])
      const facts = await client.query(
        `SELECT q.reserved_files::text AS files, q.reserved_bytes::text AS bytes,
                q.reserved_chunks::text AS chunks, q.physical_reserved_bytes::text AS physical,
                d.desired_operation_id::text AS operation, d.desired_version_id::text AS version,
                r.state FROM knowledge.kb_quotas q
         JOIN knowledge.kb_documents d ON d.owner_id = q.owner_id AND d.id = $2
         JOIN knowledge.kb_reservations r ON r.owner_id = d.owner_id AND r.operation_id = $2
         WHERE q.owner_id = $1`,
        [fixture.owners[0], fixture.id],
      )
      expect(facts.rows).toEqual([
        {
          files: '1',
          bytes: '4',
          chunks: '1',
          physical: '16',
          operation: fixture.id,
          version: fixture.id,
          state: 'held',
        },
      ])
    })
  })
})
