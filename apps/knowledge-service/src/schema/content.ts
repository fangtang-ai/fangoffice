import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  unique,
  uuid,
  vector,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { kbBuilds } from './builds'
import { bytea, counter, hashCheck, instant, knowledge, nonnegative, tsvector } from './common'

export const kbSourceUnits = knowledge
  .table(
    'kb_source_units',
    {
      ownerId: text('owner_id').notNull(),
      buildId: uuid('build_id').notNull(),
      id: uuid('id').notNull(),
      parentId: uuid('parent_id'),
      ordinal: integer('ordinal').notNull(),
      type: text('type').notNull(),
      text: text('text').notNull(),
      textHash: bytea('text_hash').notNull(),
      locator: jsonb('locator').notNull(),
      coverage: jsonb('coverage').notNull(),
      warnings: jsonb('warnings').notNull(),
      schemaVersion: integer('schema_version').notNull().default(1),
      createdAt: instant('created_at').notNull().defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.buildId, table.id] }),
      unique('kb_source_units_ordinal_unique').on(table.ownerId, table.buildId, table.ordinal),
      foreignKey({
        name: 'kb_source_units_build_fk',
        columns: [table.ownerId, table.buildId],
        foreignColumns: [kbBuilds.ownerId, kbBuilds.id],
      }),
      foreignKey({
        name: 'kb_source_units_parent_fk',
        columns: [table.ownerId, table.buildId, table.parentId],
        foreignColumns: [table.ownerId, table.buildId, table.id],
      }),
      hashCheck('kb_source_units_hash_check', table.textHash),
      nonnegative('kb_source_units_ordinal_check', table.ordinal),
      check(
        'kb_source_units_parent_check',
        sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
      ),
      check(
        'kb_source_units_schema_check',
        sql`${table.schemaVersion} = 1 AND jsonb_typeof(${table.locator}) = 'object' AND jsonb_typeof(${table.coverage}) = 'object' AND jsonb_typeof(${table.warnings}) = 'array'`,
      ),
      index('kb_source_units_parent_idx').on(
        table.ownerId,
        table.buildId,
        table.parentId,
        table.ordinal,
      ),
    ],
  )
  .enableRLS()

export const kbChunks = knowledge
  .table(
    'kb_chunks',
    {
      ownerId: text('owner_id').notNull(),
      buildId: uuid('build_id').notNull(),
      id: uuid('id').notNull(),
      ordinal: integer('ordinal').notNull(),
      text: text('text').notNull(),
      textHash: bytea('text_hash').notNull(),
      tokenCount: counter('token_count').notNull(),
      searchVector: tsvector('search_vector').notNull(),
      createdAt: instant('created_at').notNull().defaultNow(),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.buildId, table.id] }),
      unique('kb_chunks_ordinal_unique').on(table.ownerId, table.buildId, table.ordinal),
      foreignKey({
        name: 'kb_chunks_build_fk',
        columns: [table.ownerId, table.buildId],
        foreignColumns: [kbBuilds.ownerId, kbBuilds.id],
      }),
      hashCheck('kb_chunks_hash_check', table.textHash),
      nonnegative('kb_chunks_counts_check', table.ordinal, table.tokenCount),
      index('kb_chunks_search_idx').using('gin', table.searchVector),
    ],
  )
  .enableRLS()

export const kbChunkSources = knowledge
  .table(
    'kb_chunk_sources',
    {
      ownerId: text('owner_id').notNull(),
      buildId: uuid('build_id').notNull(),
      chunkId: uuid('chunk_id').notNull(),
      spanNo: integer('span_no').notNull(),
      sourceUnitId: uuid('source_unit_id').notNull(),
      startCp: integer('start_cp').notNull(),
      endCp: integer('end_cp').notNull(),
      mapping: jsonb('mapping').notNull(),
      schemaVersion: integer('schema_version').notNull().default(1),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.buildId, table.chunkId, table.spanNo] }),
      foreignKey({
        name: 'kb_chunk_sources_chunk_fk',
        columns: [table.ownerId, table.buildId, table.chunkId],
        foreignColumns: [kbChunks.ownerId, kbChunks.buildId, kbChunks.id],
      }),
      foreignKey({
        name: 'kb_chunk_sources_unit_fk',
        columns: [table.ownerId, table.buildId, table.sourceUnitId],
        foreignColumns: [kbSourceUnits.ownerId, kbSourceUnits.buildId, kbSourceUnits.id],
      }),
      check(
        'kb_chunk_sources_offsets_check',
        sql`${table.startCp} >= 0 AND ${table.endCp} > ${table.startCp}`,
      ),
      nonnegative('kb_chunk_sources_span_check', table.spanNo),
      check(
        'kb_chunk_sources_schema_check',
        sql`${table.schemaVersion} = 1 AND jsonb_typeof(${table.mapping}) = 'object'`,
      ),
      index('kb_chunk_sources_unit_idx').on(
        table.ownerId,
        table.buildId,
        table.sourceUnitId,
        table.chunkId,
      ),
    ],
  )
  .enableRLS()

export const kbChunkEmbeddings = knowledge
  .table(
    'kb_chunk_embeddings',
    {
      ownerId: text('owner_id').notNull(),
      buildId: uuid('build_id').notNull(),
      chunkId: uuid('chunk_id').notNull(),
      embedding: vector('embedding', { dimensions: 1024 }).notNull(),
      embeddedTextHash: bytea('embedded_text_hash').notNull(),
      createdAt: instant('created_at').notNull().defaultNow(),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.buildId, table.chunkId] }),
      foreignKey({
        name: 'kb_chunk_embeddings_chunk_fk',
        columns: [table.ownerId, table.buildId, table.chunkId],
        foreignColumns: [kbChunks.ownerId, kbChunks.buildId, kbChunks.id],
      }),
      hashCheck('kb_chunk_embeddings_hash_check', table.embeddedTextHash),
    ],
  )
  .enableRLS()
