import { KnowledgeContractError, parseKnowledgeMeteringEvent } from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'

const windowIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const byteMsPerGiBDay = 1073741824n * 86400000n

export interface StorageWindowRequest {
  windowId: string
  startAt: Date
  endAt: Date
  tariffRevision: string
}

interface StorageWindowRow {
  schema_version: number
  id: string
  logical_event_key: string
  event_type: string
  supersedes_event_id: string | null
  dimension: string
  unit: string
  quantity: string
  usage_source: string
  subject_kind: string
  window_id: string
  window_start: Date
  window_end: Date
  opening_sequence: string
  closing_sequence: string
  event_set_hash: string
  tariff_revision: string
  payer: string
  occurred_at: Date
}

export async function closeStorageWindow(
  transaction: KnowledgeTransaction,
  input: StorageWindowRequest,
) {
  if (
    typeof input.windowId !== 'string' ||
    !windowIdPattern.test(input.windowId) ||
    ![input.startAt, input.endAt].every(
      (value) => value instanceof Date && Number.isFinite(value.getTime()),
    )
  )
    deny('INVALID_REQUEST')
  if (
    typeof input.tariffRevision !== 'string' ||
    !input.tariffRevision.trim() ||
    input.tariffRevision.length > 128
  )
    deny('NOT_CONFIGURED')

  const { rows } = await transaction.query(
    'SELECT knowledge.close_storage_window($1, $2, $3, $4) AS status',
    [input.windowId, input.startAt.toISOString(), input.endAt.toISOString(), input.tariffRevision],
  )
  const status = (rows[0] as { status?: unknown } | undefined)?.status
  switch (status) {
    case 'CLOSED':
    case 'REPLAY':
      break
    case 'INVALID_REQUEST':
    case 'UNAUTHENTICATED':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'NOT_CONFIGURED':
    case 'QUOTA_EXCEEDED':
    case 'VERSION_CONFLICT':
      return deny(status)
    default:
      return deny('SERVICE_UNAVAILABLE')
  }

  // 与关闭窗口共用可信owner事务；只读取已落盘的不可变事实，不用请求或配额估算计量值。
  const result = await transaction.query(
    `SELECT schema_version, id::text, logical_event_key, event_type, supersedes_event_id::text,
            dimension, unit, quantity::text, usage_source, subject_kind, window_id::text,
            window_start, window_end, opening_sequence::text, closing_sequence::text,
            encode(event_set_hash, 'hex') AS event_set_hash, tariff_revision, payer, occurred_at
       FROM knowledge.kb_metering_events
      WHERE id = $1 AND subject_kind = 'storage_window' AND event_type = 'observation'`,
    [input.windowId],
  )
  const row = result.rows[0] as StorageWindowRow | undefined
  if (
    result.rows.length !== 1 ||
    !row ||
    ![row.window_start, row.window_end, row.occurred_at].every(
      (value) => value instanceof Date && Number.isFinite(value.getTime()),
    )
  )
    deny('SERVICE_UNAVAILABLE')
  const event = decodeStorageWindowEvent(row)
  if (event.dimension !== 'storage' || event.usage.quantity === null) deny('SERVICE_UNAVAILABLE')
  // 商与余数均用整数串返回；不把小于一天的byte_ms舍弃，也不经过浮点或逐段计费舍入。
  const quantity = BigInt(event.usage.quantity.value)
  return {
    replayed: status === 'REPLAY',
    event,
    gibDays: {
      wholeDays: (quantity / byteMsPerGiBDay).toString(),
      remainderByteMs: (quantity % byteMsPerGiBDay).toString(),
      byteMsPerGiBDay: byteMsPerGiBDay.toString(),
    },
  }
}

function decodeStorageWindowEvent(row: StorageWindowRow) {
  try {
    return parseKnowledgeMeteringEvent({
      schemaVersion: row.schema_version,
      id: row.id,
      eventKey: row.logical_event_key,
      product: 'knowledge_base',
      occurredAt: row.occurred_at.toISOString(),
      eventType: row.event_type,
      supersedesEventId: row.supersedes_event_id,
      tariffRevision: row.tariff_revision,
      payer: row.payer,
      dimension: row.dimension,
      subject: {
        kind: row.subject_kind,
        windowId: row.window_id,
        startAt: row.window_start.toISOString(),
        endAt: row.window_end.toISOString(),
        timezone: 'Asia/Shanghai',
        openingSequence: row.opening_sequence,
        closingSequence: row.closing_sequence,
        eventSetHash: row.event_set_hash,
      },
      usage: { source: row.usage_source, quantity: { unit: row.unit, value: row.quantity } },
    })
  } catch (error) {
    if (error instanceof KnowledgeContractError) deny('SERVICE_UNAVAILABLE')
    throw error
  }
}
