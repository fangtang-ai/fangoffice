import { deny } from '../errors'
import { loadEmbeddingEvents, requireEmbeddingId } from './embedding-event'
import type { KnowledgeTransaction } from './transaction'

export type EmbeddingIntentRequest = {
  eventId: string
  attemptId: string
  indexProfileId: string
} & (
  | { purpose: 'query'; subject: { kind: 'query'; runId: string; callId: string } }
  | {
      purpose: 'document' | 'user_rebuild' | 'platform_rebuild'
      subject: { kind: 'operation'; buildId: string }
    }
)

export interface EmbeddingResultRequest {
  eventId: string
  attemptId: string
  supersedesEventId?: string
  callState: 'completed' | 'failed' | 'unknown' | 'not_called'
  usage:
    | { source: 'unknown'; quantity: null }
    | { source: 'provider_reported' | 'reconciled'; quantity: { unit: 'tokens'; value: string } }
}

async function recordEvent(transaction: KnowledgeTransaction, values: unknown[]) {
  const { rows } = await transaction.query(
    'SELECT knowledge.record_embedding_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS status',
    values,
  )
  const status = (rows[0] as { status?: unknown } | undefined)?.status
  switch (status) {
    case 'RECORDED':
    case 'REPLAY':
      break
    case 'INVALID_REQUEST':
    case 'UNAUTHENTICATED':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'VERSION_CONFLICT':
      return deny(status)
    default:
      return deny('SERVICE_UNAVAILABLE')
  }
  const events = await loadEmbeddingEvents(transaction, String(values[0]), false)
  const event = events[0]
  if (events.length !== 1 || !event) deny('SERVICE_UNAVAILABLE')
  return { replayed: status === 'REPLAY', event }
}

export async function recordEmbeddingIntent(
  transaction: KnowledgeTransaction,
  input: EmbeddingIntentRequest,
) {
  const eventId = requireEmbeddingId(input.eventId)
  const attemptId = requireEmbeddingId(input.attemptId)
  const profileId = requireEmbeddingId(input.indexProfileId)
  if (
    !['document', 'query', 'user_rebuild', 'platform_rebuild'].includes(input.purpose) ||
    (input.purpose === 'query') !== (input.subject.kind === 'query')
  )
    deny('INVALID_REQUEST')
  const subject = input.subject
  return recordEvent(transaction, [
    eventId,
    attemptId,
    'intended',
    'unknown',
    null,
    null,
    subject.kind === 'query' ? null : requireEmbeddingId(subject.buildId),
    subject.kind === 'query' ? requireEmbeddingId(subject.runId) : null,
    subject.kind === 'query' ? requireEmbeddingId(subject.callId) : null,
    profileId,
    input.purpose,
  ])
}

export async function recordEmbeddingResult(
  transaction: KnowledgeTransaction,
  input: EmbeddingResultRequest,
) {
  const eventId = requireEmbeddingId(input.eventId)
  const attemptId = requireEmbeddingId(input.attemptId)
  const previous =
    input.supersedesEventId === undefined ? null : requireEmbeddingId(input.supersedesEventId)
  const known = input.usage.source !== 'unknown'
  // 估算不充当实际成本；未知必须是null，缓存未调用只能是已核实的0，更正只能携带已知用量。
  if (
    !['completed', 'failed', 'unknown', 'not_called'].includes(input.callState) ||
    !['unknown', 'provider_reported', 'reconciled'].includes(input.usage.source) ||
    (!known && input.usage.quantity !== null) ||
    (known &&
      (input.usage.quantity?.unit !== 'tokens' ||
        typeof input.usage.quantity.value !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(input.usage.quantity.value) ||
        BigInt(input.usage.quantity.value) > 9223372036854775807n)) ||
    (input.callState === 'unknown' && known) ||
    (input.callState === 'not_called' &&
      (input.usage.source !== 'reconciled' || input.usage.quantity.value !== '0')) ||
    (previous !== null && (!known || !['completed', 'failed'].includes(input.callState)))
  )
    deny('INVALID_REQUEST')
  return recordEvent(transaction, [
    eventId,
    attemptId,
    input.callState,
    input.usage.source,
    input.usage.source === 'unknown' ? null : input.usage.quantity.value,
    previous,
    null,
    null,
    null,
    null,
    null,
  ])
}

export async function readEmbeddingAttempt(transaction: KnowledgeTransaction, attemptId: string) {
  const events = await loadEmbeddingEvents(transaction, requireEmbeddingId(attemptId), true)
  if (events.length === 0) deny('NOT_FOUND')
  const intents = events.filter((event) => event.callState === 'intended')
  const results = events.filter((event) => event.callState !== 'intended')
  const intent = intents[0]
  if (events.length > 2 || intents.length !== 1 || !intent || results.length > 1)
    deny('SERVICE_UNAVAILABLE')
  return { intent, effective: results[0] ?? null }
}
