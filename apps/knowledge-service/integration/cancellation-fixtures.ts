import type { CapacityFixture } from './capacity-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

interface CancellationState {
  generation: string
  desired: string | null
  desired_version: string | null
  active_version: string | null
  active_build: string | null
  phase: string
  state: string
  closed: boolean
  files: string
  bytes: string
  chunks: string
  physical: string
  accounted: string
  active_files: string
  active_bytes: string
  active_chunks: string
  builds: { id: string; status: string; gc_state: string }[]
}

export async function cancellationState(
  fixture: CapacityFixture,
  operationId: string = fixture.id,
) {
  return inRoleTransaction('api', fixture.owners[0], async (client) => {
    const { rows } = await client.query<CancellationState>(
      `SELECT document.generation::text AS generation,
              document.desired_operation_id::text AS desired,
              document.desired_version_id::text AS desired_version,
              document.active_version_id::text AS active_version,
              document.active_build_id::text AS active_build,
              operation.phase, reservation.state, reservation.closed_at IS NOT NULL AS closed,
              quota.reserved_files::text AS files, quota.reserved_bytes::text AS bytes,
              quota.reserved_chunks::text AS chunks, quota.physical_reserved_bytes::text AS physical,
              quota.physical_accounted_bytes::text AS accounted,
              quota.active_files::text AS active_files, quota.active_bytes::text AS active_bytes,
              quota.active_chunks::text AS active_chunks,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status,
                'gc_state', gc_state) ORDER BY id) FROM knowledge.kb_builds
                WHERE owner_id = $1 AND operation_id = $2), '[]'::jsonb) AS builds
         FROM knowledge.kb_operations operation
         JOIN knowledge.kb_documents document ON document.owner_id = operation.owner_id
           AND document.id = operation.document_id
         JOIN knowledge.kb_quotas quota ON quota.owner_id = operation.owner_id
         JOIN knowledge.kb_reservations reservation ON reservation.owner_id = operation.owner_id
           AND reservation.operation_id = operation.id
        WHERE operation.owner_id = $1 AND operation.id = $2`,
      [fixture.owners[0], operationId],
    )
    const state = rows[0]
    if (!state) throw new Error('Missing synthetic cancellation state')
    return state
  })
}
