import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { openLocalDatabase, type LocalRole } from './local-database'

export async function inRoleTransaction<Result>(
  role: LocalRole,
  owner: string | undefined,
  work: (client: PoolClient) => Promise<Result>,
) {
  const { pool } = await openLocalDatabase(role)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (owner !== undefined)
      await client.query("SELECT set_config('knowledge.owner_id', $1, true)", [owner])
    return await work(client)
  } finally {
    try {
      await client.query('ROLLBACK')
    } finally {
      client.release()
      await pool.end()
    }
  }
}

export async function seedTenants(label: string, target: 'primary' | 'restore' = 'primary') {
  const id = randomUUID()
  const profileId = randomUUID()
  const otherDocumentId = randomUUID()
  const otherSpaceId = randomUUID()
  const owners = [`synthetic-${label}-a-${id}`, `synthetic-${label}-b-${id}`] as const
  const { pool } = await openLocalDatabase('bootstrap', target)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO knowledge.kb_index_profiles
      (id, config_hash, provider, region, model, model_revision, dimension, distance,
       normalization, pipeline_revisions, config)
      VALUES ($1, $2, 'synthetic', 'local', 'not-a-model', 'test', 1024, 'cosine', 'none', '{}', '{}')`,
      [profileId, Buffer.from(profileId.replaceAll('-', '').repeat(2), 'hex')],
    )
    for (const owner of owners) {
      const values = [owner, id, profileId]
      await client.query(
        `INSERT INTO knowledge.kb_quotas (owner_id, physical_limit_bytes, active_index_profile_id)
        VALUES ($1, 1048576, $2)`,
        [owner, profileId],
      )
      await client.query(
        `INSERT INTO knowledge.kb_spaces (owner_id, id, title)
        VALUES ($1, $2, 'Synthetic space')`,
        [owner, id],
      )
      if (owner === owners[1])
        await client.query(
          `INSERT INTO knowledge.kb_spaces (owner_id, id, title)
          VALUES ($1, $2, 'Other-owner-only space')`,
          [owner, otherSpaceId],
        )
      await client.query(
        `INSERT INTO knowledge.kb_documents (owner_id, id, space_id, title, purpose)
        VALUES ($1, $2, $2, 'Synthetic document', 'facts'), ($1, $3, $2, 'Other document', 'facts')`,
        [owner, id, otherDocumentId],
      )
      await client.query(
        `INSERT INTO knowledge.kb_operations
        (owner_id, id, document_id, idempotency_key, request_hash, kind, phase, expected_generation)
        VALUES ($1, $2, $2, 'synthetic-upload', decode(repeat('ab', 32), 'hex'), 'upload', 'uploading', 0)`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_versions
        (owner_id, document_id, id, version_no, upload_operation_id, bucket, oss_key,
         file_hash, size_bytes, format, mime, verified_at)
        VALUES ($1, $2, $2, 1, $2, 'synthetic-not-oss', $1 || '/sample.txt',
        decode(repeat('ab', 32), 'hex'), 4, 'txt', 'text/plain', now())`,
        [owner, id],
      )
      await client.query(
        `UPDATE knowledge.kb_operations SET target_version_id = $2, phase = 'queued'
        WHERE owner_id = $1 AND id = $2`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_builds
        (owner_id, id, document_id, version_id, operation_id, job_id, retry_count,
         expected_generation, index_profile_id, parser_revision, parser_snapshot)
        VALUES ($1, $2, $2, $2, $2, $2, 0, 0, $3, 'synthetic', '{}')`,
        values,
      )
      await client.query(
        `INSERT INTO knowledge.kb_source_units
        (owner_id, build_id, id, ordinal, type, text, text_hash, locator, coverage, warnings)
        VALUES ($1, $2, $2, 0, 'paragraph', 'Synthetic 雪😀',
        decode(repeat('ab', 32), 'hex'), '{}', '{}', '[]')`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_chunks
        (owner_id, build_id, id, ordinal, text, text_hash, token_count, search_vector)
        VALUES ($1, $2, $2, 0, 'Synthetic 雪😀', decode(repeat('ab', 32), 'hex'), 3,
        to_tsvector('simple', 'Synthetic'))`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_chunk_sources
        (owner_id, build_id, chunk_id, span_no, source_unit_id, start_cp, end_cp, mapping)
        VALUES ($1, $2, $2, 0, $2, 0, 1, '{}')`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_chunk_embeddings
        (owner_id, build_id, chunk_id, embedding, embedded_text_hash)
        VALUES ($1, $2, $2, $3, decode(repeat('ab', 32), 'hex'))`,
        [owner, id, JSON.stringify([1, ...Array<number>(1023).fill(0)])],
      )
      await client.query(
        `INSERT INTO knowledge.kb_reservations
        (owner_id, operation_id, document_id, expected_generation, reserved_files,
         reserved_bytes, reserved_chunks, physical_reserved_bytes, expires_at)
        VALUES ($1, $2, $2, 0, 1, 4, 1, 4, now() + interval '1 hour')`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_evidence_manifests
        (owner_id, id, run_id, mode, strategy, scope, policy_revision, expires_at)
        VALUES ($1, $2, $2, 'strict', 'synthetic', '{}', 'test-only', now() + interval '1 hour')`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_evidence_items
        (owner_id, manifest_id, citation_no, span_no, document_id, version_id, build_id,
         source_unit_id, index_profile_id, source_hash, text_hash, locator, start_cp, end_cp)
        VALUES ($1, $2, 1, 0, $2, $2, $2, $2, $3, decode(repeat('ab', 32), 'hex'),
        decode(repeat('ab', 32), 'hex'), '{}', 0, 1)`,
        values,
      )
      await client.query(
        `INSERT INTO knowledge.kb_metering_events
        (owner_id, id, logical_event_key, event_type, dimension, unit, quantity, usage_source,
         subject_kind, subject_key, sequence, active_bytes_before, active_bytes_after, payer, occurred_at)
        VALUES ($1, $2, 'synthetic-capacity', 'capacity_change', 'storage', 'bytes', 4,
        'reconciled', 'capacity_change', 'synthetic', 1, 0, 4, 'platform', now())`,
        [owner, id],
      )
      await client.query(
        `INSERT INTO knowledge.kb_billing_receipts
        (owner_id, id, settlement_key, dimension, tariff_revision, settlement_snapshot, snapshot_hash)
        VALUES ($1, $2, 'synthetic-not-billed', 'storage', 'test-only', '{}',
        decode(repeat('ab', 32), 'hex'))`,
        [owner, id],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
  return { id, profileId, otherDocumentId, otherSpaceId, owners }
}

export async function removeTenants(fixture: Awaited<ReturnType<typeof seedTenants>>) {
  const { pool } = await openLocalDatabase('bootstrap')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const allowedGuards: Record<string, readonly string[]> = {
      kb_immutable_facts: [
        'kb_index_profiles',
        'kb_versions',
        'kb_metering_events',
        'kb_billing_receipts',
      ],
      kb_build_identity: ['kb_builds'],
      kb_build_state: ['kb_builds'],
      kb_build_content: ['kb_source_units', 'kb_chunks', 'kb_chunk_sources', 'kb_chunk_embeddings'],
      // B7 发布门：发布后文档指针反向引用构建，与 operations/builds 形成 FK 环；
      // 清理时先停用门、清空指针，再按 builds → operations → documents 删除。
      kb_document_publish: ['kb_documents'],
    }
    const guards = await client.query<{ table: string; name: string; enabled: string }>(
      `
      SELECT relation.relname::text AS table, trigger.tgname::text AS name, trigger.tgenabled::text AS enabled
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
      WHERE relation.relnamespace = 'knowledge'::regnamespace
      AND trigger.tgname = ANY($1::text[]) AND NOT trigger.tgisinternal`,
      [Object.keys(allowedGuards)],
    )
    if (
      guards.rows.some(
        (guard) => guard.enabled !== 'O' || !allowedGuards[guard.name]?.includes(guard.table),
      )
    )
      throw new Error('Refusing cleanup with unexpected immutable-facts triggers')
    // Bootstrap-only cleanup holds table locks; guard changes and fixture deletes roll back together.
    for (const guard of guards.rows)
      await client.query(`ALTER TABLE knowledge.${guard.table} DISABLE TRIGGER ${guard.name}`)
    // 清空发布指针（需停用发布门）：断开 documents→builds 的 FK 环边。
    await client.query(
      `UPDATE knowledge.kb_documents
          SET active_version_id = NULL, active_build_id = NULL,
              desired_operation_id = NULL, desired_version_id = NULL
        WHERE owner_id = ANY($1::text[])`,
      [fixture.owners],
    )
    for (const table of [
      'kb_billing_receipts',
      'kb_metering_events',
      'kb_evidence_items',
      'kb_evidence_manifests',
      'kb_chunk_embeddings',
      'kb_chunk_sources',
      'kb_chunks',
      'kb_source_units',
      'kb_reservations',
      'kb_builds',
    ])
      await client.query(`DELETE FROM knowledge.${table} WHERE owner_id = ANY($1::text[])`, [
        fixture.owners,
      ])
    await client.query(
      `UPDATE knowledge.kb_operations SET target_version_id = NULL, phase = 'cancelled', error_code = NULL,
      upload_job_id = NULL, upload_queue_name = NULL
      WHERE owner_id = ANY($1::text[])`,
      [fixture.owners],
    )
    for (const table of ['kb_versions', 'kb_operations', 'kb_documents', 'kb_spaces', 'kb_quotas'])
      await client.query(`DELETE FROM knowledge.${table} WHERE owner_id = ANY($1::text[])`, [
        fixture.owners,
      ])
    await client.query('DELETE FROM knowledge.kb_index_profiles WHERE id = $1', [fixture.profileId])
    for (const guard of guards.rows)
      await client.query(`ALTER TABLE knowledge.${guard.table} ENABLE TRIGGER ${guard.name}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}
