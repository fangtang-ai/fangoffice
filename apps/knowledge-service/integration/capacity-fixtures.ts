import { randomUUID } from 'node:crypto'
import { createKnowledgePrincipal } from '../src/identity'
import { withKnowledgeTransaction, type KnowledgeTransaction } from '../src/runtime'
import { openLocalDatabase } from './local-database'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

export type CapacityFixture = Awaited<ReturnType<typeof seedTenants>> & { expiresAt: string }

export async function withCapacityFixture(work: (fixture: CapacityFixture) => Promise<void>) {
  const fixture = await seedTenants('capacity')
  try {
    const { pool } = await openLocalDatabase('bootstrap')
    try {
      await pool.query('DELETE FROM knowledge.kb_reservations WHERE owner_id = ANY($1::text[])', [
        fixture.owners,
      ])
      await pool.query(
        `UPDATE knowledge.kb_quotas
            SET policy_revision = 'synthetic', limit_files = 1, limit_bytes = 4, limit_chunks = 1
          WHERE owner_id = ANY($1::text[])`,
        [fixture.owners],
      )
    } finally {
      await pool.end()
    }
    await work({ ...fixture, expiresAt: new Date(Date.now() + 3600000).toISOString() })
  } finally {
    await removeTenants(fixture)
  }
}

export const capacityInput = (fixture: CapacityFixture) => ({
  operationId: fixture.id,
  chunks: 1n,
  physicalBytes: 16n,
  expiresAt: new Date(fixture.expiresAt),
})

export async function capacityTransaction<Result>(
  fixture: CapacityFixture,
  work: (transaction: KnowledgeTransaction) => Promise<Result>,
  owner: string = fixture.owners[0],
) {
  const { pool } = await openLocalDatabase('api')
  try {
    const now = Date.now()
    const principal = createKnowledgePrincipal(
      {
        issuer: 'https://synthetic.invalid',
        audiences: ['local-knowledge'],
        subject: owner,
        expiresAt: now + 60000,
        permissions: [],
      },
      { issuer: 'https://synthetic.invalid', audience: 'local-knowledge' },
      now,
    )
    return await withKnowledgeTransaction(pool, principal, work)
  } finally {
    await pool.end()
  }
}

export async function changeCapacityFixture(
  fixture: CapacityFixture,
  statement: string,
  values: unknown[] = [],
) {
  const { pool } = await openLocalDatabase('bootstrap')
  try {
    await pool.query(statement, [fixture.owners[0], ...values])
  } finally {
    await pool.end()
  }
}

export async function capacityState(fixture: CapacityFixture) {
  return inRoleTransaction('api', fixture.owners[0], async (client) => {
    const { rows } = await client.query<{
      files: string
      bytes: string
      chunks: string
      physical: string
      reservations: number
      desired: string | null
    }>(
      `SELECT reserved_files::text AS files, reserved_bytes::text AS bytes,
              reserved_chunks::text AS chunks, physical_reserved_bytes::text AS physical,
              (SELECT count(*)::int FROM knowledge.kb_reservations WHERE owner_id = $1) AS reservations,
              (SELECT desired_operation_id::text FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2) AS desired
         FROM knowledge.kb_quotas WHERE owner_id = $1`,
      [fixture.owners[0], fixture.id],
    )
    return rows[0]
  })
}

export async function addCapacityUpload(fixture: CapacityFixture) {
  const operationId = randomUUID()
  const { pool } = await openLocalDatabase('bootstrap')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO knowledge.kb_operations
       (owner_id, id, document_id, idempotency_key, request_hash, kind, phase, expected_generation)
       VALUES ($1, $2::uuid, $3, $2::uuid::text, decode(repeat('ab', 32), 'hex'), 'upload', 'uploading', 0)`,
      [fixture.owners[0], operationId, fixture.otherDocumentId],
    )
    await client.query(
      `INSERT INTO knowledge.kb_versions
       (owner_id, document_id, id, version_no, upload_operation_id, bucket, oss_key,
        file_hash, size_bytes, format, mime, verified_at)
       VALUES ($1, $3, $2::uuid, 1, $2::uuid, 'synthetic-not-oss', $2::uuid::text,
               decode(repeat('ab', 32), 'hex'), 4, 'txt', 'text/plain', now())`,
      [fixture.owners[0], operationId, fixture.otherDocumentId],
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
