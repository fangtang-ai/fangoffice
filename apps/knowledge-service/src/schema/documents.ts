import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  primaryKey,
  text,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { counter, instant, knowledge, nonnegative, timestamps } from './common'
import { kbSpaces } from './control'
import { kbBuilds } from './builds'
import { kbOperations } from './operations'
import { kbVersions } from './versions'

export const kbDocuments = knowledge
  .table(
    'kb_documents',
    {
      ownerId: text('owner_id').notNull(),
      id: uuid('id').notNull(),
      spaceId: uuid('space_id').notNull(),
      title: text('title').notNull(),
      purpose: text('purpose').notNull(),
      tags: text('tags')
        .array()
        .notNull()
        .default(sql`ARRAY[]::text[]`),
      activeVersionId: uuid('active_version_id'),
      activeBuildId: uuid('active_build_id'),
      desiredOperationId: uuid('desired_operation_id'),
      desiredVersionId: uuid('desired_version_id'),
      generation: counter('generation')
        .notNull()
        .default(sql`0`),
      nextVersionNo: counter('next_version_no')
        .notNull()
        .default(sql`1`),
      deletedAt: instant('deleted_at'),
      ...timestamps(),
    },
    (table): PgTableExtraConfigValue[] => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.id] }),
      foreignKey({
        name: 'kb_documents_space_fk',
        columns: [table.ownerId, table.spaceId],
        foreignColumns: [kbSpaces.ownerId, kbSpaces.id],
      }),
      foreignKey({
        name: 'kb_documents_active_version_fk',
        columns: [table.ownerId, table.id, table.activeVersionId],
        foreignColumns: [kbVersions.ownerId, kbVersions.documentId, kbVersions.id],
      }),
      foreignKey({
        name: 'kb_documents_active_build_fk',
        columns: [table.ownerId, table.id, table.activeVersionId, table.activeBuildId],
        foreignColumns: [kbBuilds.ownerId, kbBuilds.documentId, kbBuilds.versionId, kbBuilds.id],
      }),
      foreignKey({
        name: 'kb_documents_desired_operation_fk',
        columns: [table.ownerId, table.id, table.desiredOperationId],
        foreignColumns: [kbOperations.ownerId, kbOperations.documentId, kbOperations.id],
      }),
      foreignKey({
        name: 'kb_documents_desired_target_fk',
        columns: [table.ownerId, table.id, table.desiredVersionId, table.desiredOperationId],
        foreignColumns: [
          kbOperations.ownerId,
          kbOperations.documentId,
          kbOperations.targetVersionId,
          kbOperations.id,
        ],
      }),
      check('kb_documents_title_check', sql`char_length(${table.title}) BETWEEN 1 AND 200`),
      check('kb_documents_purpose_check', sql`${table.purpose} IN ('facts', 'style', 'template')`),
      check(
        'kb_documents_tags_check',
        sql`cardinality(${table.tags}) <= 20 AND array_position(${table.tags}, NULL) IS NULL AND COALESCE(array_length(${table.tags}, 1), 0) = cardinality(${table.tags}) AND char_length(array_to_string(${table.tags}, '')) <= 1000`,
      ),
      // MATCH SIMPLE permits first-upload NULLs; these checks prohibit half-bound pointers.
      check(
        'kb_documents_active_check',
        sql`(${table.activeVersionId} IS NULL) = (${table.activeBuildId} IS NULL)`,
      ),
      check(
        'kb_documents_desired_check',
        sql`${table.desiredVersionId} IS NULL OR ${table.desiredOperationId} IS NOT NULL`,
      ),
      check(
        'kb_documents_deleted_check',
        sql`${table.deletedAt} IS NULL OR (${table.activeVersionId} IS NULL AND ${table.activeBuildId} IS NULL AND ${table.desiredOperationId} IS NULL AND ${table.desiredVersionId} IS NULL)`,
      ),
      nonnegative('kb_documents_generation_check', table.generation),
      check('kb_documents_version_no_check', sql`${table.nextVersionNo} > 0`),
      index('kb_documents_listing_idx')
        .on(table.ownerId, table.spaceId, table.updatedAt.desc(), table.id.desc())
        .where(sql`${table.deletedAt} IS NULL`),
    ],
  )
  .enableRLS()
