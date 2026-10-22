import { randomUUID } from 'node:crypto'
import { bindSeedBuild } from './build-fixtures'
import { type CapacityFixture, withCapacityFixture } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

export type ReplacementFixture = CapacityFixture & { replacementId: string }

export async function prepareReplacement(
  fixture: CapacityFixture,
  {
    versionBytes = 6n,
    target = 'primary',
  }: { versionBytes?: bigint; target?: 'primary' | 'restore' } = {},
) {
  const replacementId = randomUUID()
  const { pool } = await openLocalDatabase('bootstrap', target)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
    await bindSeedBuild(client, fixture)
    await client.query(
      `UPDATE knowledge.kb_operations SET phase = 'indexing' WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await client.query(
      `UPDATE knowledge.kb_builds SET status = 'sealed', sealed_at = now(), manifest = '{}'
       WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await client.query(
      `UPDATE knowledge.kb_documents SET desired_operation_id = $2, desired_version_id = $2
       WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await client.query(
      `UPDATE knowledge.kb_documents SET active_version_id = $2, active_build_id = $2, generation = 1
       WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await client.query(
      `UPDATE knowledge.kb_operations SET phase = 'ready' WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await client.query(
      `UPDATE knowledge.kb_quotas SET active_files = 1, active_bytes = 4, active_chunks = 1,
         limit_bytes = 6, limit_chunks = 3, physical_accounted_bytes = 64 WHERE owner_id = $1`,
      [fixture.owners[0]],
    )
    await client.query(
      `INSERT INTO knowledge.kb_operations
       (owner_id, id, document_id, idempotency_key, request_hash, kind, phase, expected_generation)
       VALUES ($1, $2::uuid, $3, $2::uuid::text, decode(repeat('cd', 32), 'hex'), 'replace', 'uploading', 1)`,
      [fixture.owners[0], replacementId, fixture.id],
    )
    await client.query(
      `INSERT INTO knowledge.kb_versions
       (owner_id, document_id, id, version_no, upload_operation_id, bucket, oss_key,
        file_hash, size_bytes, format, mime, verified_at)
       VALUES ($1, $3, $2::uuid, 2, $2::uuid, 'synthetic-not-oss', $2::uuid::text,
         decode(repeat('cd', 32), 'hex'), $4, 'txt', 'text/plain', now())`,
      [fixture.owners[0], replacementId, fixture.id, versionBytes.toString()],
    )
    await client.query(
      `UPDATE knowledge.kb_operations SET phase = 'queued', target_version_id = $2
       WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], replacementId],
    )
    await client.query('COMMIT')
    return { ...fixture, replacementId }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function withReplacementFixture(
  work: (fixture: ReplacementFixture) => Promise<void>,
  options: { versionBytes?: bigint } = {},
) {
  await withCapacityFixture(async (fixture) => work(await prepareReplacement(fixture, options)))
}

export const replacementInput = (fixture: ReplacementFixture) => ({
  operationId: fixture.replacementId,
  chunks: 3n,
  physicalBytes: 32n,
  expiresAt: new Date(fixture.expiresAt),
})

export async function replacementState(fixture: ReplacementFixture) {
  return inRoleTransaction('api', fixture.owners[0], async (client) => {
    return (
      await client.query(
        `SELECT to_jsonb(quota) AS quota,
        (SELECT to_jsonb(document) FROM knowledge.kb_documents document
         WHERE owner_id = $1 AND id = $2) AS document,
        (SELECT jsonb_agg(reservation ORDER BY operation_id) FROM knowledge.kb_reservations reservation
         WHERE owner_id = $1) AS reservations
       FROM knowledge.kb_quotas quota WHERE owner_id = $1`,
        [fixture.owners[0], fixture.id],
      )
    ).rows
  })
}

export async function addCompetingReplacement(fixture: ReplacementFixture) {
  const operationId = randomUUID()
  const { pool } = await openLocalDatabase('bootstrap')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      "UPDATE knowledge.kb_operations SET phase = 'cancelled' WHERE owner_id = $1 AND id = $2",
      [fixture.owners[0], fixture.replacementId],
    )
    await client.query(
      `INSERT INTO knowledge.kb_operations
       (owner_id, id, document_id, idempotency_key, request_hash, kind, phase, expected_generation)
       VALUES ($1, $2::uuid, $3, $2::uuid::text, decode(repeat('ef', 32), 'hex'), 'replace', 'uploading', 1)`,
      [fixture.owners[0], operationId, fixture.id],
    )
    await client.query(
      `INSERT INTO knowledge.kb_versions
       (owner_id, document_id, id, version_no, upload_operation_id, bucket, oss_key,
        file_hash, size_bytes, format, mime, verified_at)
       VALUES ($1, $3, $2::uuid, 3, $2::uuid, 'synthetic-not-oss', $2::uuid::text,
         decode(repeat('ef', 32), 'hex'), 6, 'txt', 'text/plain', now())`,
      [fixture.owners[0], operationId, fixture.id],
    )
    await client.query(
      "UPDATE knowledge.kb_operations SET phase = 'queued', target_version_id = $2 WHERE owner_id = $1 AND id = $2",
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
