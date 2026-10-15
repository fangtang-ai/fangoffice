import { deny } from './errors'
import { requireKnowledgePrincipal, type KnowledgePrincipal } from './identity'

export type KnowledgePolicyEnvironment = 'production' | 'isolated_test'

export interface KnowledgeProductPolicy {
  product: 'knowledge_base'
  ownerId: string
  source: 'website' | 'internal_test'
  revision: string
  tariffRevision: string
  validFrom: number
  validUntil: number
}

export function requireProductPolicy(
  principal: KnowledgePrincipal,
  policy: KnowledgeProductPolicy | null,
  environment: KnowledgePolicyEnvironment,
  now: number,
) {
  requireKnowledgePrincipal(principal, now)
  if (
    !policy ||
    policy.product !== 'knowledge_base' ||
    !policy.revision?.trim() ||
    !policy.tariffRevision?.trim()
  )
    deny('NOT_CONFIGURED')
  if (
    policy.ownerId !== principal.ownerId ||
    !['website', 'internal_test'].includes(policy.source) ||
    (policy.source === 'internal_test' && environment !== 'isolated_test')
  )
    deny('FORBIDDEN')
  if (
    !Number.isSafeInteger(policy.validFrom) ||
    !Number.isSafeInteger(policy.validUntil) ||
    policy.validFrom > now ||
    policy.validUntil <= now ||
    policy.validUntil <= policy.validFrom
  )
    deny('SERVICE_UNAVAILABLE')
  return policy
}
