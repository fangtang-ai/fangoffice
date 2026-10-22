import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { bytea, counter, hashCheck, instant, knowledge, nonnegative, timestamps } from './common'
import { kbDocuments } from './documents'
import { kbVersions } from './versions'

export const kbOperations = knowledge
  .table(
    'kb_operations',
    {
      ownerId: text('owner_id').notNull(),
      id: uuid('id').notNull(),
      documentId: uuid('document_id').notNull(),
      idempotencyKey: text('idempotency_key').notNull(),
      requestHash: bytea('request_hash').notNull(),
      kind: text('kind').notNull(),
      phase: text('phase').notNull(),
      targetVersionId: uuid('target_version_id'),
      expectedGeneration: counter('expected_generation').notNull(),
      uploadExpiresAt: instant('upload_expires_at'),
      stagingKey: text('staging_key'),
      declaredBytes: counter('declared_bytes'),
      uploadJobId: uuid('upload_job_id'),
      uploadQueueName: text('upload_queue_name'),
      errorCode: text('error_code'),
      currentJobId: uuid('current_job_id'),
      currentRetryCount: integer('current_retry_count'),
      currentBuildId: uuid('current_build_id'),
      currentReceiptId: uuid('current_receipt_id'),
      ...timestamps(),
    },
    (table): PgTableExtraConfigValue[] => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.id] }),
      unique('kb_operations_idempotency_unique').on(table.ownerId, table.idempotencyKey),
      unique('kb_operations_document_unique').on(table.ownerId, table.documentId, table.id),
      unique('kb_operations_target_unique').on(
        table.ownerId,
        table.documentId,
        table.targetVersionId,
        table.id,
      ),
      foreignKey({
        name: 'kb_operations_document_fk',
        columns: [table.ownerId, table.documentId],
        foreignColumns: [kbDocuments.ownerId, kbDocuments.id],
      }),
      foreignKey({
        name: 'kb_operations_target_fk',
        columns: [table.ownerId, table.documentId, table.targetVersionId],
        foreignColumns: [kbVersions.ownerId, kbVersions.documentId, kbVersions.id],
      }),
      hashCheck('kb_operations_request_hash_check', table.requestHash),
      check('kb_operations_key_check', sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 128`),
      check(
        'kb_operations_kind_check',
        sql`${table.kind} IN ('upload', 'replace', 'rebuild', 'delete')`,
      ),
      check(
        'kb_operations_phase_check',
        sql`${table.phase} IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing', 'ready', 'failed', 'cancelled', 'deleting', 'deleted')`,
      ),
      check(
        'kb_operations_target_check',
        sql`${table.phase} NOT IN ('queued', 'parsing', 'indexing', 'publishing', 'ready') OR ${table.targetVersionId} IS NOT NULL`,
      ),
      check(
        'kb_operations_error_check',
        sql`(${table.phase} = 'failed') = (${table.errorCode} IS NOT NULL)`,
      ),
      check(
        'kb_operations_delete_phase_check',
        sql`(${table.kind} = 'delete' AND ${table.phase} IN ('deleting', 'deleted', 'failed', 'cancelled')) OR (${table.kind} <> 'delete' AND ${table.phase} NOT IN ('deleting', 'deleted'))`,
      ),
      // B6.3 current-attempt 绑定：四列要么全空要么全非空（绑定整体存在或整体清空）。
      check(
        'kb_operations_current_binding_check',
        sql`(${table.currentJobId} IS NULL AND ${table.currentRetryCount} IS NULL AND ${table.currentBuildId} IS NULL AND ${table.currentReceiptId} IS NULL) OR (${table.currentJobId} IS NOT NULL AND ${table.currentRetryCount} IS NOT NULL AND ${table.currentRetryCount} >= 0 AND ${table.currentBuildId} IS NOT NULL AND ${table.currentReceiptId} IS NOT NULL)`,
      ),
      nonnegative('kb_operations_counts_check', table.expectedGeneration, table.declaredBytes),
      check(
        'kb_operations_upload_job_check',
        sql`(${table.uploadJobId} IS NULL AND ${table.uploadQueueName} IS NULL) OR (${table.uploadJobId} IS NOT NULL AND ${table.uploadQueueName} IS NOT NULL AND ${table.uploadQueueName} ~ '^[a-z][a-z0-9_]{0,62}$' AND ${table.kind} = 'upload' AND ${table.phase} <> 'uploading' AND ${table.targetVersionId} IS NOT NULL)`,
      ),
      index('kb_operations_staging_idx')
        .on(table.ownerId, table.id)
        .where(sql`${table.stagingKey} IS NOT NULL`),
      uniqueIndex('kb_operations_live_unique')
        .on(table.ownerId, table.documentId)
        .where(
          sql`${table.kind} IN ('upload', 'replace', 'rebuild') AND ${table.phase} IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing')`,
        ),
    ],
  )
  .enableRLS()
