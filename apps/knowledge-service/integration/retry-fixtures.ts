import { randomUUID } from 'node:crypto'
import { cancelCapacityReservation, reserveInitialCapacity } from '../src/runtime'
import {
  capacityInput,
  capacityTransaction,
  type CapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

export async function addFollowupUpload(
  fixture: { id: string; owners: readonly [string, ...string[]] },
  {
    generation = 1n,
    kind = 'upload',
    target = 'primary',
  }: { generation?: bigint; kind?: 'upload' | 'replace'; target?: 'primary' | 'restore' } = {},
) {
  const operationId = randomUUID()
  const { pool } = await openLocalDatabase('bootstrap', target)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO knowledge.kb_operations
       (owner_id, id, document_id, idempotency_key, request_hash, kind, phase, expected_generation)
       VALUES ($1, $2::uuid, $3, $2::uuid::text, decode(repeat('ef', 32), 'hex'), $4, 'uploading', $5)`,
      [fixture.owners[0], operationId, fixture.id, kind, generation.toString()],
    )
    await client.query(
      `INSERT INTO knowledge.kb_versions
       (owner_id, document_id, id, version_no, upload_operation_id, bucket, oss_key,
        file_hash, size_bytes, format, mime, verified_at)
       SELECT $1, $3, $2::uuid, max(version_no) + 1, $2::uuid, 'synthetic-not-oss', $2::uuid::text,
         decode(repeat('ef', 32), 'hex'), 4, 'txt', 'text/plain', now()
       FROM knowledge.kb_versions WHERE owner_id = $1 AND document_id = $3`,
      [fixture.owners[0], operationId, fixture.id],
    )
    await client.query(
      `UPDATE knowledge.kb_operations SET phase = 'queued', target_version_id = $2
       WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], operationId],
    )
    await client.query('COMMIT')
    return operationId
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function withRetryFixture(
  work: (fixture: CapacityFixture & { retryId: string }) => Promise<void>,
) {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(fixture, async (transaction) => {
      await reserveInitialCapacity(transaction, capacityInput(fixture))
      await cancelCapacityReservation(transaction, fixture.id)
    })
    await work({ ...fixture, retryId: await addFollowupUpload(fixture) })
  })
}

export async function retryState(fixture: CapacityFixture) {
  return inRoleTransaction(
    'api',
    fixture.owners[0],
    async (client) =>
      (
        await client.query(
          `SELECT to_jsonb(quota) AS quota,
          (SELECT to_jsonb(document) FROM knowledge.kb_documents document
           WHERE owner_id = $1 AND id = $2) AS document,
          (SELECT jsonb_agg(operation ORDER BY id) FROM knowledge.kb_operations operation
           WHERE owner_id = $1 AND document_id = $2) AS operations,
          (SELECT jsonb_agg(reservation ORDER BY operation_id) FROM knowledge.kb_reservations reservation
           WHERE owner_id = $1 AND document_id = $2) AS reservations
         FROM knowledge.kb_quotas quota WHERE owner_id = $1`,
          [fixture.owners[0], fixture.id],
        )
      ).rows,
  )
}
