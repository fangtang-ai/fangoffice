import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  integer,
  jsonb,
  primaryKey,
  text,
  unique,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { bytea, counter, hashCheck, instant, knowledge, nonnegative } from './common'
import { kbIndexProfiles } from './control'
import { kbOperations } from './operations'
import { kbVersions } from './versions'

export const kbBuilds = knowledge
  .table(
    'kb_builds',
    {
      ownerId: text('owner_id').notNull(),
      id: uuid('id').notNull(),
      documentId: uuid('document_id').notNull(),
      versionId: uuid('version_id').notNull(),
      operationId: uuid('operation_id').notNull(),
      jobId: uuid('job_id').notNull(),
      retryCount: integer('retry_count').notNull(),
      expectedGeneration: counter('expected_generation').notNull(),
      indexProfileId: uuid('index_profile_id').notNull(),
      parserRevision: text('parser_revision').notNull(),
      parserSnapshot: jsonb('parser_snapshot').notNull(),
      schemaVersion: integer('schema_version').notNull().default(1),
      status: text('status').notNull().default('building'),
      manifest: jsonb('manifest'),
      manifestHash: bytea('manifest_hash'),
      sourceUnitCount: counter('source_unit_count')
        .notNull()
        .default(sql`0`),
      chunkCount: counter('chunk_count')
        .notNull()
        .default(sql`0`),
      embeddingCount: counter('embedding_count')
        .notNull()
        .default(sql`0`),
      sealedAt: instant('sealed_at'),
      gcState: text('gc_state').notNull().default('live'),
      purgedAt: instant('purged_at'),
      createdAt: instant('created_at').notNull().defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.id] }),
      unique('kb_builds_target_unique').on(
        table.ownerId,
        table.documentId,
        table.versionId,
        table.id,
      ),
      unique('kb_builds_operation_target_unique').on(
        table.ownerId,
        table.documentId,
        table.versionId,
        table.operationId,
        table.id,
      ),
      unique('kb_builds_attempt_unique').on(
        table.ownerId,
        table.operationId,
        table.expectedGeneration,
        table.jobId,
        table.retryCount,
      ),
      foreignKey({
        name: 'kb_builds_version_fk',
        columns: [table.ownerId, table.documentId, table.versionId],
        foreignColumns: [kbVersions.ownerId, kbVersions.documentId, kbVersions.id],
      }),
      foreignKey({
        name: 'kb_builds_operation_fk',
        columns: [table.ownerId, table.documentId, table.versionId, table.operationId],
        foreignColumns: [
          kbOperations.ownerId,
          kbOperations.documentId,
          kbOperations.targetVersionId,
          kbOperations.id,
        ],
      }),
      foreignKey({
        name: 'kb_builds_profile_fk',
        columns: [table.indexProfileId],
        foreignColumns: [kbIndexProfiles.id],
      }),
      hashCheck('kb_builds_hash_check', table.manifestHash),
      nonnegative(
        'kb_builds_counts_check',
        table.retryCount,
        table.expectedGeneration,
        table.sourceUnitCount,
        table.chunkCount,
        table.embeddingCount,
      ),
      check(
        'kb_builds_status_check',
        sql`${table.status} IN ('building', 'sealed', 'invalidated', 'purged')`,
      ),
      check(
        'kb_builds_sealed_check',
        sql`(${table.status} <> 'sealed' OR (${table.sealedAt} IS NOT NULL AND ${table.manifestHash} IS NOT NULL AND ${table.manifest} IS NOT NULL)) AND (${table.status} <> 'building' OR (${table.sealedAt} IS NULL AND ${table.manifestHash} IS NULL AND ${table.manifest} IS NULL))`,
      ),
      check(
        'kb_builds_gc_check',
        sql`${table.gcState} IN ('live', 'pending', 'purged') AND ((${table.gcState} = 'purged') = (${table.purgedAt} IS NOT NULL)) AND ((${table.status} = 'purged') = (${table.gcState} = 'purged'))`,
      ),
      check(
        'kb_builds_schema_check',
        sql`${table.schemaVersion} = 1 AND jsonb_typeof(${table.parserSnapshot}) = 'object'`,
      ),
    ],
  )
  .enableRLS()
