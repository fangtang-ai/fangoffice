import {
  choice,
  invalid,
  literal,
  nullable,
  object,
  positiveCounter,
  text,
  timestamp,
  uuid,
} from '../validation'
import { matchSnapshot, product } from './common'

const policyFields = {
  grantRevision: text(128),
  creditedFen: positiveCounter,
  expiresAt: nullable(timestamp),
  expiryRulesRevision: nullable(text(128)),
}
const policy = object(policyFields)
const grant = object({
  schemaVersion: literal(1),
  product,
  grantType: literal('new_user_grant'),
  source: literal('promotional'),
  grantId: uuid,
  ...policyFields,
  grantedAt: timestamp,
})
const grantContext = object({
  eligibility: choice(['eligible', 'ineligible', 'unknown']),
  policy: nullable(policy),
  existingGrant: nullable(grant),
  now: timestamp,
})

export function parseKnowledgePromoGrant(input: unknown, context: unknown) {
  const expected = grantContext(context, 'promoContext')
  const result = grant(input, 'promoGrant')
  if (result.grantedAt > expected.now) invalid('promoGrant.grantedAt')
  if (
    (result.expiresAt === null) !== (result.expiryRulesRevision === null) ||
    (result.expiresAt !== null && result.expiresAt <= result.grantedAt)
  )
    invalid('promoGrant.expiresAt')
  if (expected.existingGrant !== null) {
    // The trusted caller selects the same account's durable grant; its revision is not a new eligibility key.
    matchSnapshot(result, expected.existingGrant, 'promoGrant.existingGrant')
    return result
  }
  if (expected.eligibility !== 'eligible' || expected.policy === null)
    invalid('promoGrant.eligibility')
  if (result.expiresAt !== null && result.expiresAt <= expected.now) invalid('promoGrant.expiresAt')
  const { grantRevision, creditedFen, expiresAt, expiryRulesRevision } = result
  matchSnapshot(
    { grantRevision, creditedFen, expiresAt, expiryRulesRevision },
    expected.policy,
    'promoGrant.policy',
  )
  return result
}

export type KnowledgePromoGrant = ReturnType<typeof parseKnowledgePromoGrant>
