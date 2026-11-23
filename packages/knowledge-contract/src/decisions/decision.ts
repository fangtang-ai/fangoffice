import {
  choice,
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
import { empty, matchSnapshot } from '../commerce/common.js'
import { parseKnowledgeConfirmation } from './confirmation.js'
import { conflictCandidate } from './conflict.js'

const decisionFields = {
  schemaVersion: literal(1),
  id: uuid,
  requestId: uuid,
  confirmationId: uuid,
  conflictId: uuid,
  runId: uuid,
  scopeHash: sha256,
  policyRevision: text(128),
  baseManifestId: uuid,
  decidedAt: timestamp,
  evidence: conflictCandidate,
}
const confirmed = object({
  ...decisionFields,
  status: literal('confirmed'),
  choice: choice(['use_mcp', 'use_private', 'keep_both']),
  newManifestId: uuid,
})
const cancelled = object({
  ...decisionFields,
  status: literal('cancelled'),
  choice: literal('cancel'),
  newManifestId: empty,
})
const decisionContext = object({
  channel: literal('user_action'),
  runId: uuid,
  scopeHash: sha256,
  policyRevision: text(128),
  now: timestamp,
  confirmation: parseKnowledgeConfirmation,
  currentEvidence: nullable(conflictCandidate),
  newManifestId: nullable(uuid),
})

export function parseKnowledgeDecision(input: unknown, context: unknown) {
  // Only a trusted dispatcher may supply this context; a payload flag is not proof of a user action.
  const expected = decisionContext(context, 'decisionContext')
  const result =
    record(input, 'decision').status === 'cancelled'
      ? cancelled(input, 'decision')
      : confirmed(input, 'decision')
  const prompt = expected.confirmation
  if (
    result.confirmationId !== prompt.id ||
    result.baseManifestId !== prompt.manifestId ||
    result.runId !== expected.runId ||
    result.runId !== prompt.runId ||
    result.scopeHash !== expected.scopeHash ||
    result.scopeHash !== prompt.scopeHash ||
    result.policyRevision !== expected.policyRevision ||
    result.policyRevision !== prompt.policyRevision
  )
    invalid('decision.context')
  if (result.decidedAt < prompt.createdAt || result.decidedAt > expected.now)
    invalid('decision.decidedAt')
  const candidate = prompt.conflicts.find((conflict) => conflict.id === result.conflictId)
  if (candidate === undefined) invalid('decision.conflictId')
  matchSnapshot(result.evidence, candidate, 'decision.evidence')
  // Cancellation is still safe after expiry and never grants a manifest for continuation.
  if (result.status === 'cancelled') {
    if (expected.newManifestId !== null) invalid('decision.newManifestId')
    return result
  }
  if (prompt.expiresAt <= expected.now || expected.currentEvidence === null)
    invalid('decision.currentEvidence')
  matchSnapshot(result.evidence, expected.currentEvidence, 'decision.currentEvidence')
  if (
    result.newManifestId !== expected.newManifestId ||
    result.newManifestId === result.baseManifestId
  )
    invalid('decision.newManifestId')
  return result
}

export type KnowledgeDecision = ReturnType<typeof parseKnowledgeDecision>
