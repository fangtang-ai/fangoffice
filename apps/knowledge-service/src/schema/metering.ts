import { ownerPolicies } from './owner-policy'
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { kbBuilds } from './builds'
import { bytea, counter, hashCheck, instant, knowledge, nonnegative } from './common'
import { kbIndexProfiles, kbQuotas } from './control'
import { kbOperations } from './operations'
import { meteringChecks } from './metering-checks'

export const kbMeteringEvents = knowledge
  .table(
    'kb_metering_events',
    {
      ownerId: text('owner_id').notNull(),
      id: uuid('id').notNull(),
      logicalEventKey: text('logical_event_key').notNull(),
      eventType: text('event_type').notNull(),
      supersedesEventId: uuid('supersedes_event_id'),
      dimension: text('dimension').notNull(),
      unit: text('unit').notNull(),
      quantity: numeric('quantity', { precision: 38, scale: 0 }),
      usageSource: text('usage_source').notNull(),
      subjectKind: text('subject_kind').notNull(),
      subjectKey: text('subject_key').notNull(),
      documentId: uuid('document_id'),
      versionId: uuid('version_id'),
      operationId: uuid('operation_id'),
      buildId: uuid('build_id'),
      runId: uuid('run_id'),
      callId: uuid('call_id'),
      attemptId: uuid('attempt_id'),
      indexProfileId: uuid('index_profile_id'),
      purpose: text('purpose'),
      callState: text('call_state'),
      completion: text('completion'),
      sequence: counter('sequence'),
      activeBytesBefore: counter('active_bytes_before'),
      activeBytesAfter: counter('active_bytes_after'),
      windowId: uuid('window_id'),
      windowStart: instant('window_start'),
      windowEnd: instant('window_end'),
      openingSequence: counter('opening_sequence'),
      closingSequence: counter('closing_sequence'),
      eventSetHash: bytea('event_set_hash'),
      tariffRevision: text('tariff_revision'),
      payer: text('payer').notNull(),
      schemaVersion: integer('schema_version').notNull().default(1),
      occurredAt: instant('occurred_at').notNull(),
      deliveryState: text('delivery_state').notNull().default('pending'),
      deliveryAttempts: integer('delivery_attempts').notNull().default(0),
      nextAttemptAt: instant('next_attempt_at').notNull().defaultNow(),
      deliveredAt: instant('delivered_at'),
      createdAt: instant('created_at').notNull().defaultNow(),
    },
    (table): PgTableExtraConfigValue[] => [
      ...ownerPolicies(table.ownerId),
      primaryKey({ columns: [table.ownerId, table.id] }),
      unique('kb_metering_events_logical_unique').on(table.ownerId, table.logicalEventKey),
      foreignKey({
        name: 'kb_metering_events_owner_fk',
        columns: [table.ownerId],
        foreignColumns: [kbQuotas.ownerId],
      }),
      foreignKey({
        name: 'kb_metering_events_operation_fk',
        columns: [table.ownerId, table.documentId, table.versionId, table.operationId],
        foreignColumns: [
          kbOperations.ownerId,
          kbOperations.documentId,
          kbOperations.targetVersionId,
          kbOperations.id,
        ],
      }),
      foreignKey({
        name: 'kb_metering_events_build_fk',
        columns: [
          table.ownerId,
          table.documentId,
          table.versionId,
          table.operationId,
          table.buildId,
        ],
        foreignColumns: [
          kbBuilds.ownerId,
          kbBuilds.documentId,
          kbBuilds.versionId,
          kbBuilds.operationId,
          kbBuilds.id,
        ],
      }),
      foreignKey({
        name: 'kb_metering_events_profile_fk',
        columns: [table.indexProfileId],
        foreignColumns: [kbIndexProfiles.id],
      }),
      foreignKey({
        name: 'kb_metering_events_supersedes_fk',
        columns: [table.ownerId, table.supersedesEventId],
        foreignColumns: [table.ownerId, table.id],
      }),
      check(
        'kb_metering_events_key_check',
        sql`char_length(${table.logicalEventKey}) BETWEEN 1 AND 128 AND char_length(${table.subjectKey}) BETWEEN 1 AND 128`,
      ),
      check(
        'kb_metering_events_kind_check',
        sql`${table.eventType} IN ('observation', 'correction', 'capacity_change') AND ${table.dimension} IN ('storage', 'embedding') AND ${table.usageSource} IN ('unknown', 'estimated', 'provider_reported', 'reconciled') AND ${table.payer} IN ('customer', 'platform') AND ${table.schemaVersion} = 1`,
      ),
      check(
        'kb_metering_events_correction_check',
        sql`((${table.eventType} = 'correction') = (${table.supersedesEventId} IS NOT NULL)) AND (${table.supersedesEventId} IS NULL OR ${table.supersedesEventId} <> ${table.id}) AND (${table.eventType} <> 'correction' OR ${table.usageSource} IN ('provider_reported', 'reconciled'))`,
      ),
      ...meteringChecks(table),
      hashCheck('kb_metering_events_set_hash_check', table.eventSetHash),
      nonnegative(
        'kb_metering_events_counts_check',
        table.sequence,
        table.activeBytesBefore,
        table.activeBytesAfter,
        table.openingSequence,
        table.closingSequence,
        table.deliveryAttempts,
      ),
      check(
        'kb_metering_events_delivery_check',
        sql`${table.deliveryState} IN ('pending', 'delivered', 'reconciling') AND ((${table.deliveryState} = 'delivered') = (${table.deliveredAt} IS NOT NULL))`,
      ),
      uniqueIndex('kb_metering_events_sequence_unique')
        .on(table.ownerId, table.sequence)
        .where(sql`${table.eventType} = 'capacity_change'`),
      uniqueIndex('kb_metering_events_storage_window_unique')
        .on(table.ownerId, table.windowStart)
        .where(sql`${table.subjectKind} = 'storage_window' AND ${table.eventType} = 'observation'`),
      index('kb_metering_events_embedding_attempt_idx')
        .on(table.ownerId, table.attemptId, table.id)
        .where(sql`${table.dimension} = 'embedding'`),
      uniqueIndex('kb_metering_events_embedding_successor_unique')
        .on(table.ownerId, table.supersedesEventId)
        .where(sql`${table.dimension} = 'embedding' AND ${table.eventType} = 'correction'`),
      index('kb_metering_events_time_idx').on(
        table.ownerId,
        table.occurredAt,
        table.sequence,
        table.id,
      ),
      index('kb_metering_events_delivery_idx')
        .on(table.nextAttemptAt, table.ownerId, table.id)
        .where(sql`${table.deliveryState} IN ('pending', 'reconciling')`),
    ],
  )
  .enableRLS()
