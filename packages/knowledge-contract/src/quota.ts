import { counter, choice, invalid, nullable, object, text, timestamp, uuid } from './validation.js'

const capacity = object({ files: counter, bytes: counter, chunks: counter })
export function parseKnowledgeCapacity(input: unknown) {
  return capacity(input, 'capacity')
}

export type KnowledgeCapacity = ReturnType<typeof parseKnowledgeCapacity>

const quota = object({
  ownerState: choice(['active', 'frozen', 'closed']),
  activeIndexProfileId: nullable(uuid),
  policyRevision: nullable(text(128)),
  updatedAt: timestamp,
  limits: nullable(capacity),
  active: capacity,
  reserved: capacity,
  physical: object({ accountedBytes: counter, reservedBytes: counter, limitBytes: counter }),
})

export function parseKnowledgeQuota(input: unknown) {
  const result = quota(input, 'quota')
  if ((result.policyRevision === null) !== (result.limits === null)) invalid('quota.limits')
  if (result.policyRevision !== null && result.activeIndexProfileId === null) {
    invalid('quota.activeIndexProfileId')
  }
  // Existing usage may exceed downgraded limits; admission is a separate server policy.
  return result
}

export type KnowledgeQuota = ReturnType<typeof parseKnowledgeQuota>
