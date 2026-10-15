import {
  parseKnowledgeCapacity,
  parseKnowledgeQuantity,
  parseKnowledgeQuota,
} from '@genoffice/knowledge-contract'
import { deny } from './errors'
import type { KnowledgePrincipal } from './identity'
import {
  requireProductPolicy,
  type KnowledgePolicyEnvironment,
  type KnowledgeProductPolicy,
} from './product-policy'

export interface KnowledgeQuotaFacts {
  ownerId: string
  value: unknown
}

export interface KnowledgeCapacityProjection {
  next: unknown
  replaced: unknown | null
  physicalBytes: unknown
}

export function evaluateCapacity(
  environment: KnowledgePolicyEnvironment,
  principal: KnowledgePrincipal,
  facts: KnowledgeQuotaFacts,
  policyInput: KnowledgeProductPolicy | null,
  projection: KnowledgeCapacityProjection,
  now: number,
) {
  const policy = requireProductPolicy(principal, policyInput, environment, now)
  if (facts.ownerId !== principal.ownerId) deny('FORBIDDEN')
  const quota = parseKnowledgeQuota(facts.value)
  if (quota.ownerState !== 'active') deny('FORBIDDEN')
  if (quota.limits === null || quota.policyRevision === null) deny('NOT_CONFIGURED')
  const limits = quota.limits
  if (quota.policyRevision !== policy.revision || Date.parse(quota.updatedAt) > now)
    deny('SERVICE_UNAVAILABLE')
  const next = parseKnowledgeCapacity(projection.next)
  const replaced = projection.replaced === null ? null : parseKnowledgeCapacity(projection.replaced)
  const physical = parseKnowledgeQuantity({ unit: 'bytes', value: projection.physicalBytes })
  const dimensions = ['files', 'bytes', 'chunks'] as const
  const positiveDelta = { files: '0', bytes: '0', chunks: '0' }
  for (const dimension of dimensions) {
    const oldValue = BigInt(replaced?.[dimension] ?? '0')
    if (oldValue > BigInt(quota.active[dimension])) deny('VERSION_CONFLICT')
    const delta = BigInt(next[dimension]) - oldValue
    // Replacement credit never releases negative deltas before publication.
    positiveDelta[dimension] = (delta > 0n ? delta : 0n).toString()
  }
  const remediation =
    replaced !== null && dimensions.every((dimension) => positiveDelta[dimension] === '0')
  if (
    !remediation &&
    dimensions.some(
      (dimension) =>
        BigInt(quota.active[dimension]) +
          BigInt(quota.reserved[dimension]) +
          BigInt(positiveDelta[dimension]) >
        BigInt(limits[dimension]),
    )
  )
    deny('QUOTA_EXCEEDED')
  if (
    BigInt(quota.physical.accountedBytes) +
      BigInt(quota.physical.reservedBytes) +
      BigInt(physical.value) >
    BigInt(quota.physical.limitBytes)
  )
    deny('QUOTA_EXCEEDED')
  return { positiveDelta, physicalBytes: physical.value, remediation }
}
