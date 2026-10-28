import {
  choice,
  invalid,
  literal,
  nullable,
  object,
  record,
  text,
  timestamp,
  uuid,
} from '../validation.js'
import { parseStorageWindow, product } from './common.js'
import { parseEmbeddingUsage, parseStorageUsage } from './usage.js'

const eventFields = {
  schemaVersion: literal(1),
  id: uuid,
  eventKey: text(128),
  product,
  occurredAt: timestamp,
  eventType: choice(['observation', 'correction']),
  supersedesEventId: nullable(uuid),
  tariffRevision: nullable(text(128)),
  payer: choice(['customer', 'platform']),
}
const operationSubject = object({
  kind: literal('operation'),
  spaceId: uuid,
  documentId: uuid,
  operationId: uuid,
  versionId: uuid,
  buildId: uuid,
})
const querySubject = object({ kind: literal('query'), runId: uuid, callId: uuid })

function parseEmbeddingSubject(input: unknown) {
  const source = record(input, 'subject')
  if (source.kind === 'operation') return operationSubject(input, 'subject')
  if (source.kind === 'query') return querySubject(input, 'subject')
  invalid('subject.kind')
}

const storageEvent = object({
  ...eventFields,
  dimension: literal('storage'),
  subject: parseStorageWindow,
  usage: parseStorageUsage,
})
const embeddingEvent = object({
  ...eventFields,
  dimension: literal('embedding'),
  subject: parseEmbeddingSubject,
  attemptId: uuid,
  indexProfileId: uuid,
  purpose: choice(['document', 'query', 'user_rebuild', 'platform_rebuild']),
  callState: choice(['intended', 'completed', 'failed', 'unknown', 'not_called']),
  completion: choice(['published', 'evidence_complete', 'none']),
  usage: parseEmbeddingUsage,
})

export function decodeMeteringEvent(input: unknown) {
  const source = record(input, 'meteringEvent')
  if (source.dimension === 'storage') return storageEvent(input, 'meteringEvent')
  if (source.dimension === 'embedding') return embeddingEvent(input, 'meteringEvent')
  invalid('meteringEvent.dimension')
}
