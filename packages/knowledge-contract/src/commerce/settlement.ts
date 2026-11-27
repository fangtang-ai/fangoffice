import {
  invalid,
  list,
  literal,
  object,
  record,
  sha256,
  text,
  unique,
  uuid,
} from '../validation.js'
import { parseStorageWindow, product, storageQuantity, tokenQuantity } from './common.js'

const fields = {
  schemaVersion: literal(1),
  product,
  settlementKey: text(128),
  tariffRevision: text(128),
}
const eventCoverage = object({
  kind: literal('events'),
  eventIds: list(uuid, 1, 1000),
  eventSetHash: sha256,
})
const embedding = object({
  ...fields,
  dimension: literal('embedding'),
  quantity: tokenQuantity,
  coverage: eventCoverage,
})
const storage = object({
  ...fields,
  dimension: literal('storage'),
  quantity: storageQuantity,
  coverage: parseStorageWindow,
})

export function parseKnowledgeSettlementSnapshot(input: unknown) {
  const source = record(input, 'settlement')
  if (source.dimension === 'storage') return storage(input, 'settlement')
  if (source.dimension === 'embedding') {
    const result = embedding(input, 'settlement')
    unique(result.coverage.eventIds, (id) => id, 'settlement.coverage.eventIds')
    return result
  }
  invalid('settlement.dimension')
}

export type KnowledgeSettlementSnapshot = ReturnType<typeof parseKnowledgeSettlementSnapshot>
