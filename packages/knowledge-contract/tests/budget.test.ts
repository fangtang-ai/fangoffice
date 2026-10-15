import { expect, expectTypeOf, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeBudget } from '../src'
import { budgetContext, estimatedBudget, fixtureId, later, now } from './commerce-fixtures'

it('keeps an explicit estimate separate from an authorized reservation', () => {
  expect(parseKnowledgeBudget(estimatedBudget, budgetContext)).toEqual(estimatedBudget)
})

const authorized = {
  ...estimatedBudget,
  status: 'authorized',
  reservation: { reservationId: fixtureId(41), expiresAt: later, reservedFen: '100' },
}

it('requires an explicit live reservation instead of assuming a short chat TTL', () => {
  expect(parseKnowledgeBudget(authorized, budgetContext)).toEqual(authorized)
  const result = parseKnowledgeBudget(authorized, budgetContext)
  if (result.status === 'authorized') expectTypeOf(result.reservation).not.toBeNullable()
})

it('supports storage byte-time hard limits without floating conversion', () => {
  const storage = {
    ...estimatedBudget,
    dimension: 'storage',
    purpose: 'storage',
    estimatedQuantity: { unit: 'byte_ms', value: '9223372036854775808' },
    maxQuantity: { unit: 'byte_ms', value: '99999999999999999999999999999999999999' },
  }
  expect(parseKnowledgeBudget(storage, { ...budgetContext, purpose: 'storage' })).toEqual(storage)
})

it('accepts a user rebuild only with the matching trusted confirmation reference', () => {
  const rebuild = { ...authorized, purpose: 'user_rebuild', confirmationId: fixtureId(42) }
  expect(
    parseKnowledgeBudget(rebuild, {
      ...budgetContext,
      purpose: 'user_rebuild',
      confirmationId: fixtureId(42),
    }),
  ).toEqual(rebuild)
})

it.each([
  {
    label: 'over quantity cap',
    input: { ...estimatedBudget, maxQuantity: { unit: 'tokens', value: '16' } },
    context: budgetContext,
  },
  {
    label: 'mismatched quantity units',
    input: { ...estimatedBudget, maxQuantity: { unit: 'byte_ms', value: '20' } },
    context: budgetContext,
  },
  {
    label: 'missing policy',
    input: estimatedBudget,
    context: { ...budgetContext, policyRevision: null },
  },
  {
    label: 'scope drift',
    input: estimatedBudget,
    context: { ...budgetContext, scopeHash: 'd'.repeat(64) },
  },
  {
    label: 'tariff drift',
    input: estimatedBudget,
    context: { ...budgetContext, tariffRevision: 'other' },
  },
  { label: 'expired estimate', input: estimatedBudget, context: { ...budgetContext, now: later } },
  { label: 'future issue', input: { ...estimatedBudget, issuedAt: later }, context: budgetContext },
  {
    label: 'estimate posing as reserved',
    input: { ...estimatedBudget, reservation: authorized.reservation },
    context: budgetContext,
  },
  {
    label: 'missing reservation',
    input: { ...authorized, reservation: null },
    context: budgetContext,
  },
  {
    label: 'expired reservation',
    input: { ...authorized, reservation: { ...authorized.reservation, expiresAt: now } },
    context: budgetContext,
  },
  {
    label: 'reservation beyond budget',
    input: {
      ...authorized,
      reservation: { ...authorized.reservation, expiresAt: '2026-10-16T00:00:00.000Z' },
    },
    context: budgetContext,
  },
  {
    label: 'insufficient reserved cap',
    input: { ...authorized, reservation: { ...authorized.reservation, reservedFen: '99' } },
    context: budgetContext,
  },
  {
    label: 'unconfirmed rebuild',
    input: { ...authorized, purpose: 'user_rebuild' },
    context: { ...budgetContext, purpose: 'user_rebuild' },
  },
  {
    label: 'forged confirmation',
    input: { ...authorized, purpose: 'user_rebuild', confirmationId: fixtureId(42) },
    context: { ...budgetContext, purpose: 'user_rebuild' },
  },
  {
    label: 'client balance',
    input: { ...authorized, balanceFen: '99999' },
    context: budgetContext,
  },
  {
    label: 'wrong product',
    input: { ...authorized, product: 'office_ai' },
    context: budgetContext,
  },
])('rejects budget $label', ({ input, context }) => {
  expect(() => parseKnowledgeBudget(input, context)).toThrow(KnowledgeContractError)
})
