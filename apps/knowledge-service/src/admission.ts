import {
  evaluateCapacity,
  type KnowledgeCapacityProjection,
  type KnowledgeQuotaFacts,
} from './capacity'
import {
  evaluateBudget,
  type KnowledgeBudgetRequirement,
  type KnowledgeWebsiteReservation,
} from './budget'
import { deny } from './errors'
import type { KnowledgePrincipal } from './identity'
import type { KnowledgePolicyEnvironment, KnowledgeProductPolicy } from './product-policy'

export function createKnowledgeAdmissionPolicy(
  environment: KnowledgePolicyEnvironment = 'production',
) {
  if (environment !== 'production' && environment !== 'isolated_test') deny('NOT_CONFIGURED')
  return {
    budget(
      principal: KnowledgePrincipal,
      policy: KnowledgeProductPolicy | null,
      input: unknown,
      requirement: KnowledgeBudgetRequirement,
      reservation: KnowledgeWebsiteReservation | null,
      now: number,
    ) {
      return evaluateBudget(environment, principal, policy, input, requirement, reservation, now)
    },
    capacity(
      principal: KnowledgePrincipal,
      facts: KnowledgeQuotaFacts,
      policy: KnowledgeProductPolicy | null,
      projection: KnowledgeCapacityProjection,
      now: number,
    ) {
      return evaluateCapacity(environment, principal, facts, policy, projection, now)
    },
  }
}
