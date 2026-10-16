import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  primaryKey,
  text,
  unique,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { bytea, counter, hashCheck, instant, knowledge, nonnegative } from './common'
import { kbDocuments } from './documents'
import { kbOperations } from './operations'

export const kbVersions = knowledge
  .table(
    'kb_versions',
    {
      ownerId: text('owner_id').notNull(),
      documentId: uuid('document_id').notNull(),
      id: uuid('id').notNull(),
      versionNo: counter('version_no').notNull(),
      uploadOperationId: uuid('upload_operation_id').notNull(),
      bucket: text('bucket').notNull(),
      ossKey: text('oss_key').notNull(),
      fileHash: bytea('file_hash').notNull(),
      sizeBytes: counter('size_bytes').notNull(),
      format: text('format').notNull(),
      mime: text('mime').notNull(),
      verifiedAt: instant('verified_at').notNull(),
      retainUntil: instant('retain_until'),
      gcState: text('gc_state').notNull().default('live'),
      purgedAt: instant('purged_at'),
      createdAt: instant('created_at').notNull().defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.documentId, table.id] }),
      unique('kb_versions_number_unique').on(table.ownerId, table.documentId, table.versionNo),
      unique('kb_versions_object_unique').on(table.bucket, table.ossKey),
      foreignKey({
        name: 'kb_versions_document_fk',
        columns: [table.ownerId, table.documentId],
        foreignColumns: [kbDocuments.ownerId, kbDocuments.id],
      }),
      foreignKey({
        name: 'kb_versions_upload_fk',
        columns: [table.ownerId, table.documentId, table.uploadOperationId],
        foreignColumns: [kbOperations.ownerId, kbOperations.documentId, kbOperations.id],
      }),
      hashCheck('kb_versions_hash_check', table.fileHash),
      nonnegative('kb_versions_size_check', table.sizeBytes),
      check('kb_versions_number_check', sql`${table.versionNo} > 0`),
      check(
        'kb_versions_format_check',
        sql`${table.format} IN ('txt', 'md', 'docx', 'pdf', 'xlsx')`,
      ),
      check(
        'kb_versions_gc_check',
        sql`${table.gcState} IN ('live', 'pending', 'purged') AND ((${table.gcState} = 'purged') = (${table.purgedAt} IS NOT NULL))`,
      ),
    ],
  )
  .enableRLS()
