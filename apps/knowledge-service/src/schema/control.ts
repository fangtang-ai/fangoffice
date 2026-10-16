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
} from 'drizzle-orm/pg-core'
import { bytea, counter, hashCheck, instant, knowledge, nonnegative, timestamps } from './common'

export const kbIndexProfiles = knowledge.table(
  'kb_index_profiles',
  {
    id: uuid('id').primaryKey(),
    configHash: bytea('config_hash').notNull(),
    provider: text('provider').notNull(),
    region: text('region').notNull(),
    model: text('model').notNull(),
    modelRevision: text('model_revision').notNull(),
    dimension: integer('dimension').notNull(),
    distance: text('distance').notNull(),
    normalization: text('normalization').notNull(),
    pipelineRevisions: jsonb('pipeline_revisions').notNull(),
    config: jsonb('config').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('kb_index_profiles_config_hash_unique').on(table.configHash),
    hashCheck('kb_index_profiles_hash_check', table.configHash),
    check(
      'kb_index_profiles_dimension_check',
      sql`${table.dimension} > 0 AND ${table.dimension} <= 16000`,
    ),
    check(
      'kb_index_profiles_distance_check',
      sql`${table.distance} IN ('cosine', 'l2', 'inner_product')`,
    ),
    check(
      'kb_index_profiles_schema_check',
      sql`${table.schemaVersion} = 1 AND jsonb_typeof(${table.config}) = 'object' AND jsonb_typeof(${table.pipelineRevisions}) = 'object'`,
    ),
  ],
)

export const kbQuotas = knowledge
  .table(
    'kb_quotas',
    {
      ownerId: text('owner_id').primaryKey(),
      ownerState: text('owner_state').notNull().default('active'),
      activeIndexProfileId: uuid('active_index_profile_id'),
      policyRevision: text('policy_revision'),
      limitFiles: counter('limit_files'),
      limitBytes: counter('limit_bytes'),
      limitChunks: counter('limit_chunks'),
      activeFiles: counter('active_files')
        .notNull()
        .default(sql`0`),
      activeBytes: counter('active_bytes')
        .notNull()
        .default(sql`0`),
      activeChunks: counter('active_chunks')
        .notNull()
        .default(sql`0`),
      reservedFiles: counter('reserved_files')
        .notNull()
        .default(sql`0`),
      reservedBytes: counter('reserved_bytes')
        .notNull()
        .default(sql`0`),
      reservedChunks: counter('reserved_chunks')
        .notNull()
        .default(sql`0`),
      physicalAccountedBytes: counter('physical_accounted_bytes')
        .notNull()
        .default(sql`0`),
      physicalReservedBytes: counter('physical_reserved_bytes')
        .notNull()
        .default(sql`0`),
      physicalLimitBytes: counter('physical_limit_bytes').notNull(),
      ...timestamps(),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      foreignKey({
        name: 'kb_quotas_profile_fk',
        columns: [table.activeIndexProfileId],
        foreignColumns: [kbIndexProfiles.id],
      }),
      check('kb_quotas_state_check', sql`${table.ownerState} IN ('active', 'frozen', 'closed')`),
      check(
        'kb_quotas_policy_check',
        sql`((${table.policyRevision} IS NULL AND ${table.limitFiles} IS NULL AND ${table.limitBytes} IS NULL AND ${table.limitChunks} IS NULL) OR (${table.policyRevision} IS NOT NULL AND ${table.limitFiles} IS NOT NULL AND ${table.limitBytes} IS NOT NULL AND ${table.limitChunks} IS NOT NULL AND ${table.activeIndexProfileId} IS NOT NULL))`,
      ),
      nonnegative(
        'kb_quotas_counts_check',
        table.limitFiles,
        table.limitBytes,
        table.limitChunks,
        table.activeFiles,
        table.activeBytes,
        table.activeChunks,
        table.reservedFiles,
        table.reservedBytes,
        table.reservedChunks,
        table.physicalAccountedBytes,
        table.physicalReservedBytes,
        table.physicalLimitBytes,
      ),
    ],
  )
  .enableRLS()

export const kbSpaces = knowledge
  .table(
    'kb_spaces',
    {
      ownerId: text('owner_id').notNull(),
      id: uuid('id').notNull(),
      title: text('title').notNull(),
      state: text('state').notNull().default('active'),
      deletedAt: instant('deleted_at'),
      ...timestamps(),
    },
    (table) => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.id] }),
      foreignKey({
        name: 'kb_spaces_owner_fk',
        columns: [table.ownerId],
        foreignColumns: [kbQuotas.ownerId],
      }),
      check('kb_spaces_title_check', sql`char_length(${table.title}) BETWEEN 1 AND 200`),
      check(
        'kb_spaces_state_check',
        sql`${table.state} IN ('active', 'frozen', 'deleting', 'deleted')`,
      ),
      check(
        'kb_spaces_deleted_check',
        sql`(${table.state} = 'deleted') = (${table.deletedAt} IS NOT NULL)`,
      ),
    ],
  )
  .enableRLS()
