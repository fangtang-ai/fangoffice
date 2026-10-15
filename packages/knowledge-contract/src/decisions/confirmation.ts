import {
  invalid,
  list,
  literal,
  object,
  sha256,
  text,
  timestamp,
  unique,
  uuid,
} from '../validation'
import { conflictCandidate } from './conflict'

const confirmation = object({
  schemaVersion: literal(1),
  id: uuid,
  status: literal('needs_confirmation'),
  runId: uuid,
  scopeHash: sha256,
  manifestId: uuid,
  policyRevision: text(128),
  createdAt: timestamp,
  expiresAt: timestamp,
  conflicts: list(conflictCandidate, 1, 10),
})

export function parseKnowledgeConfirmation(input: unknown) {
  const result = confirmation(input, 'confirmation')
  unique(result.conflicts, (conflict) => conflict.id, 'confirmation.conflicts')
  if (result.createdAt >= result.expiresAt) invalid('confirmation.expiresAt')
  for (const conflict of result.conflicts) {
    if (conflict.mcp.observedAt > result.createdAt || conflict.mcp.validUntil < result.expiresAt)
      invalid('confirmation.conflicts.mcp.validUntil')
  }
  return result
}

export type KnowledgeConfirmation = ReturnType<typeof parseKnowledgeConfirmation>
export type { KnowledgeConflictCandidate } from './conflict'
