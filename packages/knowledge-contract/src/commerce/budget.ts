import {
  choice,
  counter,
  invalid,
  literal,
  nullable,
  object,
  record,
  sha256,
  text,
  timestamp,
  uuid,
} from '../validation.js'
import { empty, product, storageQuantity, tokenQuantity } from './common.js'

const budgetFields = {
  schemaVersion: literal(1),
  id: uuid,
  product,
  scopeHash: sha256,
  policyRevision: text(128),
  tariffRevision: text(128),
  issuedAt: timestamp,
  expiresAt: timestamp,
  maxChargeFen: counter,
}
const embeddingFields = {
  ...budgetFields,
  dimension: literal('embedding'),
  purpose: choice(['document', 'query', 'user_rebuild']),
  estimatedQuantity: tokenQuantity,
  maxQuantity: tokenQuantity,
}
const estimated = { status: literal('estimated'), reservation: empty, confirmationId: empty }
const authorized = {
  status: literal('authorized'),
  reservation: object({ reservationId: uuid, expiresAt: timestamp, reservedFen: counter }),
  confirmationId: nullable(uuid),
}
const storageFields = {
  ...budgetFields,
  dimension: literal('storage'),
  purpose: literal('storage'),
  estimatedQuantity: storageQuantity,
  maxQuantity: storageQuantity,
}
const embeddingEstimate = object({ ...embeddingFields, ...estimated })
const embeddingAuthorization = object({ ...embeddingFields, ...authorized })
const storageEstimate = object({ ...storageFields, ...estimated })
const storageAuthorization = object({ ...storageFields, ...authorized })
const budgetContext = object({
  scopeHash: sha256,
  purpose: choice(['document', 'query', 'user_rebuild', 'storage']),
  policyRevision: text(128),
  tariffRevision: text(128),
  confirmationId: nullable(uuid),
  now: timestamp,
})

function decodeBudget(input: unknown) {
  const source = record(input, 'budget')
  if (source.dimension === 'embedding')
    return source.status === 'estimated'
      ? embeddingEstimate(input, 'budget')
      : embeddingAuthorization(input, 'budget')
  if (source.dimension === 'storage')
    return source.status === 'estimated'
      ? storageEstimate(input, 'budget')
      : storageAuthorization(input, 'budget')
  invalid('budget.dimension')
}

export function parseKnowledgeBudget(input: unknown, context: unknown) {
  const expected = budgetContext(context, 'budgetContext')
  const result = decodeBudget(input)
  if (
    result.scopeHash !== expected.scopeHash ||
    result.purpose !== expected.purpose ||
    result.policyRevision !== expected.policyRevision ||
    result.tariffRevision !== expected.tariffRevision ||
    result.confirmationId !== expected.confirmationId
  )
    invalid('budget.context')
  if (
    result.issuedAt > expected.now ||
    result.expiresAt <= expected.now ||
    result.expiresAt <= result.issuedAt
  )
    invalid('budget.expiresAt')
  if (BigInt(result.estimatedQuantity.value) > BigInt(result.maxQuantity.value))
    invalid('budget.maxQuantity')
  if (result.status === 'authorized') {
    // The caller must verify this reservation with the website; parsing only checks its snapshot.
    if (
      result.reservation.expiresAt <= expected.now ||
      result.reservation.expiresAt > result.expiresAt ||
      BigInt(result.reservation.reservedFen) < BigInt(result.maxChargeFen)
    )
      invalid('budget.reservation')
    if (result.purpose === 'user_rebuild' && result.confirmationId === null)
      invalid('budget.confirmationId')
  }
  return result
}

export type KnowledgeBudget = ReturnType<typeof parseKnowledgeBudget>
