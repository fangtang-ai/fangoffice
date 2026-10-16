import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { seedTenants } from './tenant-fixtures'

export type BuildFixture = Awaited<ReturnType<typeof seedTenants>>
export const contentTables = [
  'kb_source_units',
  'kb_chunks',
  'kb_chunk_sources',
  'kb_chunk_embeddings',
] as const
export type ContentTable = (typeof contentTables)[number]

export const closedBuildStates = {
  sealed:
    "status = 'sealed', sealed_at = now(), manifest = '{}', manifest_hash = decode(repeat('ab', 32), 'hex'), source_unit_count = 1, chunk_count = 1, embedding_count = 1",
  invalidated: "status = 'invalidated'",
  pending: "gc_state = 'pending'",
  purged: "status = 'purged', gc_state = 'purged', purged_at = now()",
} as const

export async function changeBuild(client: PoolClient, fixture: BuildFixture, assignment: string) {
  return client.query(
    `UPDATE knowledge.kb_builds SET ${assignment} WHERE owner_id = $1 AND id = $2`,
    [fixture.owners[0], fixture.id],
  )
}

export async function prepareContentInsert(
  client: PoolClient,
  fixture: BuildFixture,
  table: ContentTable,
  ordinal = 1,
) {
  const chunkId = randomUUID()
  if (table === 'kb_chunk_embeddings') {
    const chunk = await prepareContentInsert(client, fixture, 'kb_chunks', ordinal)
    await client.query(chunk.text, [
      fixture.owners[0],
      fixture.id,
      JSON.stringify({ id: chunkId, ordinal }),
    ])
  }
  const patch =
    table === 'kb_chunk_sources'
      ? { span_no: ordinal }
      : table === 'kb_chunk_embeddings'
        ? { chunk_id: chunkId }
        : { id: randomUUID(), ordinal }
  return {
    text: `INSERT INTO knowledge.${table} SELECT
      (jsonb_populate_record(NULL::knowledge.${table}, to_jsonb(sample) || $3::jsonb)).*
      FROM knowledge.${table} sample WHERE owner_id = $1 AND build_id = $2 LIMIT 1`,
    values: [fixture.owners[0], fixture.id, JSON.stringify(patch)],
  }
}
