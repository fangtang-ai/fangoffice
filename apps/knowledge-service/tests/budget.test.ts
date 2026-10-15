import { expect, it } from 'vitest'
import { createKnowledgeAdmissionPolicy } from '../src'
import { productPolicy } from './capacity-fixtures'
import { ids, later, now, otherOwnerId, ownerId, principal } from './fixtures'

const budget = {
  schemaVersion: 1,
  id: ids.operation,
  product: 'knowledge_base',
  dimension: 'embedding',
  purpose: 'document',
  scopeHash: 'c'.repeat(64),
  policyRevision: 'synthetic-policy-1',
  tariffRevision: 'synthetic-tariff-1',
  issuedAt: '2026-10-15T00:00:00.000Z',
  expiresAt: later,
  status: 'authorized',
  estimatedQuantity: { unit: 'tokens', value: '17' },
  maxQuantity: { unit: 'tokens', value: '20' },
  maxChargeFen: '100',
  reservation: { reservationId: ids.version, expiresAt: later, reservedFen: '100' },
  confirmationId: null,
}
const requirement = {
  scopeHash: budget.scopeHash,
  purpose: 'document' as const,
  confirmationId: null,
  quantity: { unit: 'tokens', value: '18' },
}
function reservation() {
  return {
    ownerId,
    product: 'knowledge_base' as const,
    budgetId: budget.id,
    reservationId: ids.version,
    status: 'held' as const,
    scopeHash: budget.scopeHash,
    purpose: 'document' as const,
    policyRevision: budget.policyRevision,
    tariffRevision: budget.tariffRevision,
    confirmationId: null,
    expiresAt: later,
    reservedFen: '100',
  }
}

it('requires a same-owner website-held reservation bound to the exact budget and scope', () => {
  expect(
    createKnowledgeAdmissionPolicy().budget(
      principal(),
      productPolicy(),
      budget,
      requirement,
      reservation(),
      now,
    ),
  ).toEqual(budget)
})

it('keeps large byte-time storage budgets distinct from embedding token budgets', () => {
  const storage = {
    ...budget,
    dimension: 'storage',
    purpose: 'storage',
    estimatedQuantity: { unit: 'byte_ms', value: '9223372036854775808' },
    maxQuantity: { unit: 'byte_ms', value: '9223372036854775809' },
  }
  const request = {
    ...requirement,
    purpose: 'storage' as const,
    quantity: { unit: 'byte_ms', value: '9223372036854775809' },
  }
  expect(
    createKnowledgeAdmissionPolicy().budget(
      principal(),
      productPolicy(),
      storage,
      request,
      { ...reservation(), purpose: 'storage' },
      now,
    ).maxQuantity.value,
  ).toBe('9223372036854775809')
})

it('requires the same trusted confirmation for an explicitly authorized user rebuild', () => {
  const rebuild = { ...budget, purpose: 'user_rebuild', confirmationId: ids.build }
  const request = { ...requirement, purpose: 'user_rebuild' as const, confirmationId: ids.build }
  expect(
    createKnowledgeAdmissionPolicy().budget(
      principal(),
      productPolicy(),
      rebuild,
      request,
      { ...reservation(), purpose: 'user_rebuild', confirmationId: ids.build },
      now,
    ).confirmationId,
  ).toBe(ids.build)
})

it('rejects a mere estimate, missing reservation and an expired authorization', () => {
  const admission = createKnowledgeAdmissionPolicy()
  expect(() =>
    admission.budget(
      principal(),
      productPolicy(),
      { ...budget, status: 'estimated', reservation: null },
      requirement,
      reservation(),
      now,
    ),
  ).toThrow('FORBIDDEN')
  expect(() =>
    admission.budget(principal(), productPolicy(), budget, requirement, null, now),
  ).toThrow('FORBIDDEN')
  expect(() =>
    admission.budget(
      principal(),
      productPolicy(),
      { ...budget, expiresAt: budget.issuedAt },
      requirement,
      reservation(),
      now,
    ),
  ).toThrow()
})

it.each([
  'ownerId',
  'product',
  'budgetId',
  'reservationId',
  'status',
  'scopeHash',
  'purpose',
  'policyRevision',
  'tariffRevision',
  'confirmationId',
  'expiresAt',
  'reservedFen',
] as const)('rejects a website fact that disagrees on %s', (field) => {
  const facts = reservation()
  Object.defineProperty(facts, field, {
    value: field === 'ownerId' ? otherOwnerId : 'synthetic-wrong-value',
  })
  expect(() =>
    createKnowledgeAdmissionPolicy().budget(
      principal(),
      productPolicy(),
      budget,
      requirement,
      facts,
      now,
    ),
  ).toThrow('FORBIDDEN')
})

it('refuses quantity overflow or a mismatched unit before new paid work', () => {
  const admission = createKnowledgeAdmissionPolicy()
  expect(() =>
    admission.budget(
      principal(),
      productPolicy(),
      budget,
      { ...requirement, quantity: { unit: 'tokens', value: '21' } },
      reservation(),
      now,
    ),
  ).toThrow('QUOTA_EXCEEDED')
  expect(() =>
    admission.budget(
      principal(),
      productPolicy(),
      budget,
      { ...requirement, quantity: { unit: 'bytes', value: '1' } },
      reservation(),
      now,
    ),
  ).toThrow('INVALID_REQUEST')
})

it('never treats a different scope, tariff or confirmation as equivalent authorization', () => {
  const admission = createKnowledgeAdmissionPolicy()
  expect(() =>
    admission.budget(
      principal(),
      productPolicy(),
      budget,
      { ...requirement, scopeHash: 'd'.repeat(64) },
      reservation(),
      now,
    ),
  ).toThrow()
  expect(() =>
    admission.budget(
      principal(),
      productPolicy({ tariffRevision: 'other' }),
      budget,
      requirement,
      reservation(),
      now,
    ),
  ).toThrow()
  expect(() =>
    admission.budget(
      principal(),
      productPolicy(),
      { ...budget, purpose: 'user_rebuild' },
      { ...requirement, purpose: 'user_rebuild' },
      { ...reservation(), purpose: 'user_rebuild' },
      now,
    ),
  ).toThrow()
})

it('keeps synthetic financial facts isolated instead of enabling a production free fallback', () => {
  const testPolicy = productPolicy({ source: 'internal_test' })
  expect(() =>
    createKnowledgeAdmissionPolicy().budget(
      principal(),
      testPolicy,
      budget,
      requirement,
      reservation(),
      now,
    ),
  ).toThrow('FORBIDDEN')
  expect(
    createKnowledgeAdmissionPolicy('isolated_test').budget(
      principal(),
      testPolicy,
      budget,
      requirement,
      reservation(),
      now,
    ).status,
  ).toBe('authorized')
})
