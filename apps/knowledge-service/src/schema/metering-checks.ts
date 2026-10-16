import { sql } from 'drizzle-orm'
import { check, type PgColumn } from 'drizzle-orm/pg-core'
import type { kbMeteringEvents } from './metering'

type MeteringColumns = Record<keyof (typeof kbMeteringEvents)['_']['columns'], PgColumn>

export function meteringChecks(table: MeteringColumns) {
  // Explicit NULL branches keep PostgreSQL CHECK's unknown result from accepting partial subjects.
  return [
    check(
      'kb_metering_events_quantity_check',
      sql`
      (${table.usageSource} = 'unknown' AND ${table.quantity} IS NULL) OR
      (${table.usageSource} <> 'unknown' AND ${table.quantity} IS NOT NULL AND ${table.quantity} >= 0)
    `,
    ),
    check(
      'kb_metering_events_unit_check',
      sql`
      (${table.dimension} = 'embedding' AND ${table.unit} = 'tokens'
        AND (${table.quantity} IS NULL OR ${table.quantity} <= 9223372036854775807)) OR
      (${table.dimension} = 'storage' AND ${table.eventType} <> 'capacity_change'
        AND ${table.unit} = 'byte_ms' AND ${table.usageSource} <> 'provider_reported') OR
      (${table.dimension} = 'storage' AND ${table.eventType} = 'capacity_change'
        AND ${table.unit} = 'bytes' AND ${table.quantity} IS NOT NULL
        AND ${table.quantity} <= 9223372036854775807)
    `,
    ),
    check(
      'kb_metering_events_subject_check',
      sql`
      (${table.subjectKind} = 'operation' AND ${table.dimension} = 'embedding'
        AND ${table.documentId} IS NOT NULL AND ${table.versionId} IS NOT NULL
        AND ${table.operationId} IS NOT NULL AND ${table.buildId} IS NOT NULL
        AND ${table.runId} IS NULL AND ${table.callId} IS NULL) OR
      (${table.subjectKind} = 'query' AND ${table.dimension} = 'embedding'
        AND ${table.documentId} IS NULL AND ${table.versionId} IS NULL
        AND ${table.operationId} IS NULL AND ${table.buildId} IS NULL
        AND ${table.runId} IS NOT NULL AND ${table.callId} IS NOT NULL) OR
      (${table.subjectKind} IN ('storage_window', 'capacity_change') AND ${table.dimension} = 'storage'
        AND ${table.documentId} IS NULL AND ${table.versionId} IS NULL
        AND ${table.operationId} IS NULL AND ${table.buildId} IS NULL
        AND ${table.runId} IS NULL AND ${table.callId} IS NULL)
    `,
    ),
    check(
      'kb_metering_events_embedding_check',
      sql`
      (${table.dimension} = 'storage' AND ${table.attemptId} IS NULL AND ${table.indexProfileId} IS NULL
        AND ${table.purpose} IS NULL AND ${table.callState} IS NULL AND ${table.completion} IS NULL) OR
      (${table.dimension} = 'embedding' AND ${table.eventType} <> 'capacity_change'
        AND ${table.attemptId} IS NOT NULL AND ${table.indexProfileId} IS NOT NULL
        AND ${table.purpose} IS NOT NULL AND ${table.purpose} IN ('document', 'query', 'user_rebuild', 'platform_rebuild')
        AND ${table.callState} IS NOT NULL AND ${table.callState} IN ('intended', 'completed', 'failed', 'unknown', 'not_called')
        AND ${table.completion} IS NOT NULL AND ${table.completion} IN ('published', 'evidence_complete', 'none')
        AND ((${table.subjectKind} = 'query') = (${table.purpose} = 'query'))
        AND (${table.callState} NOT IN ('intended', 'unknown') OR ${table.usageSource} = 'unknown')
        AND (${table.callState} <> 'not_called' OR (${table.usageSource} = 'reconciled' AND ${table.quantity} = 0))
        AND (${table.callState} = 'completed' OR ${table.completion} = 'none')
        AND (${table.subjectKind} <> 'query' OR ${table.completion} <> 'published')
        AND (${table.subjectKind} <> 'operation' OR ${table.completion} <> 'evidence_complete'))
    `,
    ),
    check(
      'kb_metering_events_capacity_check',
      sql`
      (${table.eventType} = 'capacity_change' AND ${table.subjectKind} = 'capacity_change'
        AND ${table.sequence} IS NOT NULL AND ${table.activeBytesBefore} IS NOT NULL
        AND ${table.activeBytesAfter} IS NOT NULL AND ${table.quantity} = ${table.activeBytesAfter}
        AND ${table.payer} = 'platform' AND ${table.usageSource} = 'reconciled') OR
      (${table.eventType} <> 'capacity_change' AND ${table.subjectKind} <> 'capacity_change'
        AND ${table.sequence} IS NULL AND ${table.activeBytesBefore} IS NULL AND ${table.activeBytesAfter} IS NULL)
    `,
    ),
    check(
      'kb_metering_events_window_check',
      sql`
      (${table.subjectKind} = 'storage_window' AND ${table.windowId} IS NOT NULL
        AND ${table.windowStart} IS NOT NULL AND ${table.windowEnd} IS NOT NULL
        AND ${table.windowEnd} > ${table.windowStart} AND ${table.windowEnd} <= ${table.occurredAt}
        AND ${table.openingSequence} IS NOT NULL AND ${table.closingSequence} IS NOT NULL
        AND ${table.openingSequence} <= ${table.closingSequence} AND ${table.eventSetHash} IS NOT NULL) OR
      (${table.subjectKind} <> 'storage_window' AND ${table.windowId} IS NULL
        AND ${table.windowStart} IS NULL AND ${table.windowEnd} IS NULL
        AND ${table.openingSequence} IS NULL AND ${table.closingSequence} IS NULL AND ${table.eventSetHash} IS NULL)
    `,
    ),
    check(
      'kb_metering_events_payer_check',
      sql`
      ${table.payer} <> 'customer' OR (${table.tariffRevision} IS NOT NULL
        AND ${table.usageSource} IN ('provider_reported', 'reconciled')
        AND (${table.dimension} <> 'embedding' OR (${table.callState} = 'completed'
          AND ${table.completion} <> 'none' AND ${table.purpose} <> 'platform_rebuild')))
    `,
    ),
  ]
}
