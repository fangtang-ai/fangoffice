import { afterAll, beforeAll, expect, it } from 'vitest'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('constraints')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

for (const [description, statement, code] of [
  [
    'cross-owner parent',
    'UPDATE knowledge.kb_documents SET space_id = $3 WHERE owner_id = $1 AND id = $2',
    '23503',
  ],
  [
    'same-owner wrong-document operation',
    'UPDATE knowledge.kb_documents SET desired_operation_id = $2 WHERE owner_id = $1 AND id = $3',
    '23503',
  ],
  [
    'half-bound active pointer',
    'UPDATE knowledge.kb_documents SET active_version_id = $2 WHERE owner_id = $1 AND id = $2 AND $3::uuid IS NOT NULL',
    '23514',
  ],
  [
    'negative counters',
    'UPDATE knowledge.kb_quotas SET active_bytes = -1 WHERE owner_id = $1 AND $2::uuid IS NOT NULL AND $3::uuid IS NOT NULL',
    '23514',
  ],
  [
    'unsafe hash',
    "UPDATE knowledge.kb_versions SET file_hash = decode('ab', 'hex') WHERE owner_id = $1 AND id = $2 AND $3::uuid IS NOT NULL",
    '23514',
  ],
  [
    'incomplete seal',
    "UPDATE knowledge.kb_builds SET status = 'sealed' WHERE owner_id = $1 AND id = $2 AND $3::uuid IS NOT NULL",
    '23514',
  ],
  [
    'invalid code-point offsets',
    `INSERT INTO knowledge.kb_chunk_sources (owner_id, build_id, chunk_id, span_no, source_unit_id, start_cp, end_cp, mapping)
     VALUES ($1, $2, $2, 1, $2, 1, 1, jsonb_build_object('test', $3::uuid))`,
    '23514',
  ],
  [
    'wrong vector dimension',
    "UPDATE knowledge.kb_chunk_embeddings SET embedding = '[1,0]' WHERE owner_id = $1 AND build_id = $2 AND $3::uuid IS NOT NULL",
    '22000',
  ],
  [
    'unknown usage pretending zero',
    "UPDATE knowledge.kb_metering_events SET usage_source = 'unknown' WHERE owner_id = $1 AND id = $2 AND $3::uuid IS NOT NULL",
    '23514',
  ],
  [
    'receipt without site confirmation',
    "UPDATE knowledge.kb_billing_receipts SET status = 'settled' WHERE owner_id = $1 AND id = $2 AND $3::uuid IS NOT NULL",
    '23514',
  ],
] as const) {
  it(`rejects ${description} in PostgreSQL rather than only a schema snapshot`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      const parent =
        description === 'cross-owner parent' ? fixture.otherSpaceId : fixture.otherDocumentId
      await expect(
        client.query(statement, [fixture.owners[0], fixture.id, parent]),
      ).rejects.toMatchObject({ code })
    })
  })
}

// B7 发布门先行于 FK：活跃指针的任何翻转都先过发布门复核，
// admission 未就绪即 23514 kb_document_publish_gate（比 FK 更早、更强；
// FK 本身仍由上面 cross-owner parent / wrong-document operation 两例运行时覆盖）。
it('rejects same-owner wrong-document version through the publication gate before the FK', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    await expect(
      client.query(
        'UPDATE knowledge.kb_documents SET active_version_id = $2, active_build_id = $2 WHERE owner_id = $1 AND id = $3',
        [fixture.owners[0], fixture.id, fixture.otherDocumentId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'kb_document_publish_gate',
    })
  })
})
