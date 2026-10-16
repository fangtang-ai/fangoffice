import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import { check, foreignKey, integer, jsonb, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { bytea, hashCheck, instant, knowledge, nonnegative } from './common'
import { kbQuotas } from './control'

export const kbEvidenceManifests = knowledge
  .table(
    'kb_evidence_manifests',
    {
      ownerId: text('owner_id').notNull(),
      id: uuid('id').notNull(),
      runId: uuid('run_id').notNull(),
      mode: text('mode').notNull(),
      strategy: text('strategy').notNull(),
      scope: jsonb('scope').notNull(),
      policyRevision: text('policy_revision').notNull(),
      decision: jsonb('decision'),
      schemaVersion: integer('schema_version').notNull().default(1),
      sealedAt: instant('sealed_at'),
      revokedAt: instant('revoked_at'),
      createdAt: instant('created_at').notNull().defaultNow(),
      expiresAt: instant('expires_at').notNull(),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.id] }),
      foreignKey({
        name: 'kb_evidence_manifests_owner_fk',
        columns: [table.ownerId],
        foreignColumns: [kbQuotas.ownerId],
      }),
      check('kb_evidence_manifests_mode_check', sql`${table.mode} IN ('strict', 'assisted')`),
      check('kb_evidence_manifests_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
      check(
        'kb_evidence_manifests_schema_check',
        sql`${table.schemaVersion} = 1 AND jsonb_typeof(${table.scope}) = 'object' AND (${table.decision} IS NULL OR jsonb_typeof(${table.decision}) = 'object')`,
      ),
    ],
  )
  .enableRLS()

export const kbEvidenceItems = knowledge
  .table(
    'kb_evidence_items',
    {
      ownerId: text('owner_id').notNull(),
      manifestId: uuid('manifest_id').notNull(),
      citationNo: integer('citation_no').notNull(),
      spanNo: integer('span_no').notNull(),
      documentId: uuid('document_id').notNull(),
      versionId: uuid('version_id').notNull(),
      buildId: uuid('build_id').notNull(),
      sourceUnitId: uuid('source_unit_id').notNull(),
      indexProfileId: uuid('index_profile_id').notNull(),
      sourceHash: bytea('source_hash').notNull(),
      textHash: bytea('text_hash').notNull(),
      locator: jsonb('locator').notNull(),
      startCp: integer('start_cp').notNull(),
      endCp: integer('end_cp').notNull(),
      schemaVersion: integer('schema_version').notNull().default(1),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.manifestId, table.citationNo, table.spanNo] }),
      foreignKey({
        name: 'kb_evidence_items_manifest_fk',
        columns: [table.ownerId, table.manifestId],
        foreignColumns: [kbEvidenceManifests.ownerId, kbEvidenceManifests.id],
      }),
      hashCheck('kb_evidence_items_source_hash_check', table.sourceHash),
      hashCheck('kb_evidence_items_text_hash_check', table.textHash),
      check(
        'kb_evidence_items_offsets_check',
        sql`${table.startCp} >= 0 AND ${table.endCp} > ${table.startCp}`,
      ),
      check('kb_evidence_items_citation_check', sql`${table.citationNo} > 0`),
      nonnegative('kb_evidence_items_span_check', table.spanNo),
      check(
        'kb_evidence_items_schema_check',
        sql`${table.schemaVersion} = 1 AND jsonb_typeof(${table.locator}) = 'object'`,
      ),
    ],
  )
  .enableRLS()
