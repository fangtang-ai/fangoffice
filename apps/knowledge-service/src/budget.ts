import {
  parseKnowledgeBudget,
  parseKnowledgeQuantity,
  type KnowledgeBudget,
} from '@genoffice/knowledge-contract'
import { deny } from './errors'
import type { KnowledgePrincipal } from './identity'
import {
  requireProductPolicy,
  type KnowledgePolicyEnvironment,
  type KnowledgeProductPolicy,
} from './product-policy'

export interface KnowledgeBudgetRequirement {
  scopeHash: string
  purpose: KnowledgeBudget['purpose']
  confirmationId: string | null
  quantity: unknown
}

export interface KnowledgeWebsiteReservation {
  ownerId: string
  product: 'knowledge_base'
  budgetId: string
  reservationId: string
  status: 'held' | 'captured' | 'released'
  scopeHash: string
  purpose: KnowledgeBudget['purpose']
  policyRevision: string
  tariffRevision: string
  confirmationId: string | null
  expiresAt: string
  reservedFen: string
}

export function evaluateBudget(
  environment: KnowledgePolicyEnvironment,
  principal: KnowledgePrincipal,
  policyInput: KnowledgeProductPolicy | null,
  input: unknown,
  requirement: KnowledgeBudgetRequirement,
  reservation: KnowledgeWebsiteReservation | null,
  now: number,
) {
  const policy = requireProductPolicy(principal, policyInput, environment, now)
  const budget = parseKnowledgeBudget(input, {
    scopeHash: requirement.scopeHash,
    purpose: requirement.purpose,
    confirmationId: requirement.confirmationId,
    policyRevision: policy.revision,
    tariffRevision: policy.tariffRevision,
    now: new Date(now).toISOString(),
  })
  if (budget.status !== 'authorized' || !reservation) deny('FORBIDDEN')
  // Reservation facts must come from the trusted website adapter, never from the request body.
  if (
    reservation.ownerId !== principal.ownerId ||
    reservation.product !== 'knowledge_base' ||
    reservation.status !== 'held' ||
    reservation.budgetId !== budget.id ||
    reservation.reservationId !== budget.reservation.reservationId ||
    reservation.expiresAt !== budget.reservation.expiresAt ||
    reservation.reservedFen !== budget.reservation.reservedFen ||
    reservation.scopeHash !== budget.scopeHash ||
    reservation.purpose !== budget.purpose ||
    reservation.policyRevision !== budget.policyRevision ||
    reservation.tariffRevision !== budget.tariffRevision ||
    reservation.confirmationId !== budget.confirmationId
  )
    deny('FORBIDDEN')
  const quantity = parseKnowledgeQuantity(requirement.quantity)
  if (quantity.unit !== budget.maxQuantity.unit) deny('INVALID_REQUEST')
  if (BigInt(quantity.value) > BigInt(budget.maxQuantity.value)) deny('QUOTA_EXCEEDED')
  return budget
}
