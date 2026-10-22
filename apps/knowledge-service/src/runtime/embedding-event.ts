import { KnowledgeContractError, parseKnowledgeMeteringEvent } from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'

interface EmbeddingRow {
  schema_version: number
  id: string
  logical_event_key: string
  occurred_at: string
  event_type: string
  supersedes_event_id: string | null
  tariff_revision: string | null
  payer: string
  dimension: string
  subject_kind: string
  space_id: string | null
  document_id: string | null
  version_id: string | null
  operation_id: string | null
  build_id: string | null
  run_id: string | null
  call_id: string | null
  attempt_id: string
  index_profile_id: string
  purpose: string
  call_state: string
  completion: string
  usage_source: string
  unit: string
  quantity: string | null
}

function eventInput(row: EmbeddingRow) {
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    eventKey: row.logical_event_key,
    product: 'knowledge_base',
    occurredAt: new Date(row.occurred_at).toISOString(),
    eventType: row.event_type,
    supersedesEventId: row.supersedes_event_id,
    tariffRevision: row.tariff_revision,
    payer: row.payer,
    dimension: row.dimension,
    subject:
      row.subject_kind === 'query'
        ? { kind: 'query', runId: row.run_id, callId: row.call_id }
        : {
            kind: row.subject_kind,
            spaceId: row.space_id,
            documentId: row.document_id,
            versionId: row.version_id,
            operationId: row.operation_id,
            buildId: row.build_id,
          },
    attemptId: row.attempt_id,
    indexProfileId: row.index_profile_id,
    purpose: row.purpose,
    callState: row.call_state,
    completion: row.completion,
    usage: {
      source: row.usage_source,
      quantity: row.quantity === null ? null : { unit: row.unit, value: row.quantity },
    },
  }
}

export function requireEmbeddingId(value: string) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    deny('INVALID_REQUEST')
  return value.toLowerCase()
}

export async function loadEmbeddingEvents(
  transaction: KnowledgeTransaction,
  id: string,
  leaf: boolean,
) {
  // 只读取指定事件或指定attempt的intent/当前叶；更正用同一快照的直接前驱验证，数量转文本避免JSON数值丢精度。
  const { rows } = await transaction.query(
    `SELECT to_jsonb(entry) || jsonb_build_object('quantity', entry.quantity::text,
              'space_id', document.space_id) AS current,
            CASE WHEN previous.id IS NULL THEN NULL ELSE to_jsonb(previous) ||
              jsonb_build_object('quantity', previous.quantity::text, 'space_id', document.space_id) END AS previous
       FROM knowledge.kb_metering_events entry
       LEFT JOIN knowledge.kb_documents document
         ON document.owner_id = entry.owner_id AND document.id = entry.document_id
       LEFT JOIN knowledge.kb_metering_events previous
         ON previous.owner_id = entry.owner_id AND previous.id = entry.supersedes_event_id
      WHERE entry.dimension = 'embedding' AND ${
        leaf
          ? `entry.attempt_id = $1 AND (entry.call_state = 'intended' OR NOT EXISTS (
            SELECT 1 FROM knowledge.kb_metering_events successor
             WHERE successor.owner_id = entry.owner_id AND successor.dimension = 'embedding'
               AND successor.event_type = 'correction' AND successor.supersedes_event_id = entry.id))`
          : 'entry.id = $1'
      }
      ORDER BY entry.id LIMIT 3`,
    [id],
  )
  return rows.map((value) => {
    const row = value as { current: EmbeddingRow; previous: EmbeddingRow | null }
    try {
      const event = parseKnowledgeMeteringEvent(
        eventInput(row.current),
        row.previous ? eventInput(row.previous) : null,
      )
      if (event.dimension !== 'embedding') return deny('SERVICE_UNAVAILABLE')
      return event
    } catch (error) {
      if (error instanceof KnowledgeContractError || error instanceof RangeError)
        deny('SERVICE_UNAVAILABLE')
      throw error
    }
  })
}
