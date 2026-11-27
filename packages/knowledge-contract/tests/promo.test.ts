import { expect, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgePromoGrant } from '../src'
import { fixtureId, later, promoContext, promoGrant } from './commerce-fixtures'

it('accepts an explicitly configured promotional grant without a fake paid order', () => {
  expect(parseKnowledgePromoGrant(promoGrant, promoContext)).toEqual(promoGrant)
})

it('replays the original grant even after eligibility and policy version change', () => {
  const replay = {
    ...promoContext,
    eligibility: 'ineligible',
    policy: { ...promoContext.policy, grantRevision: 'synthetic-grant-v2', creditedFen: '200' },
    existingGrant: promoGrant,
  }
  expect(parseKnowledgePromoGrant(promoGrant, replay)).toEqual(promoGrant)
})

it('permits historical replay without a current policy, not a new credit', () => {
  expect(
    parseKnowledgePromoGrant(promoGrant, {
      ...promoContext,
      policy: null,
      existingGrant: promoGrant,
    }),
  ).toEqual(promoGrant)
})

it('accepts disclosed expiry and keeps an expired historical grant unchanged', () => {
  const expiring = {
    ...promoGrant,
    expiresAt: later,
    expiryRulesRevision: 'synthetic-disclosed-expiry-1',
  }
  const policy = {
    ...promoContext.policy,
    expiresAt: later,
    expiryRulesRevision: expiring.expiryRulesRevision,
  }
  expect(parseKnowledgePromoGrant(expiring, { ...promoContext, policy })).toEqual(expiring)
  expect(
    parseKnowledgePromoGrant(expiring, {
      ...promoContext,
      policy: null,
      existingGrant: expiring,
      now: '2026-10-16T00:00:00.000Z',
    }),
  ).toEqual(expiring)
})

it.each([
  {
    label: 'version-based second grant',
    input: {
      ...promoGrant,
      grantId: fixtureId(51),
      grantRevision: 'synthetic-grant-v2',
      creditedFen: '200',
    },
    context: {
      ...promoContext,
      policy: { ...promoContext.policy, grantRevision: 'synthetic-grant-v2', creditedFen: '200' },
      existingGrant: promoGrant,
    },
  },
  {
    label: 'same version new ID',
    input: { ...promoGrant, grantId: fixtureId(51) },
    context: { ...promoContext, existingGrant: promoGrant },
  },
  {
    label: 'replay amount drift',
    input: { ...promoGrant, creditedFen: '101' },
    context: { ...promoContext, existingGrant: promoGrant },
  },
  {
    label: 'unconfigured new grant',
    input: promoGrant,
    context: { ...promoContext, policy: null },
  },
  {
    label: 'unknown eligibility',
    input: promoGrant,
    context: { ...promoContext, eligibility: 'unknown' },
  },
  {
    label: 'ineligible new grant',
    input: promoGrant,
    context: { ...promoContext, eligibility: 'ineligible' },
  },
  {
    label: 'hidden expiry',
    input: { ...promoGrant, expiresAt: later },
    context: { ...promoContext, policy: { ...promoContext.policy, expiresAt: later } },
  },
  {
    label: 'expired first grant',
    input: { ...promoGrant, expiresAt: later, expiryRulesRevision: 'synthetic-expiry' },
    context: {
      ...promoContext,
      policy: { ...promoContext.policy, expiresAt: later, expiryRulesRevision: 'synthetic-expiry' },
      now: '2026-10-16T00:00:00.000Z',
    },
  },
  {
    label: 'zero promotional credit',
    input: { ...promoGrant, creditedFen: '0' },
    context: { ...promoContext, policy: { ...promoContext.policy, creditedFen: '0' } },
  },
  { label: 'paid source', input: { ...promoGrant, source: 'paid' }, context: promoContext },
  {
    label: 'fake paid order',
    input: { ...promoGrant, orderId: fixtureId(99) },
    context: promoContext,
  },
  { label: 'owner injection', input: { ...promoGrant, userId: 'forged' }, context: promoContext },
  { label: 'wrong product', input: { ...promoGrant, product: 'office_ai' }, context: promoContext },
  {
    label: 'unconfigured amount',
    input: { ...promoGrant, creditedFen: '101' },
    context: promoContext,
  },
])('rejects promo $label', ({ input, context }) => {
  expect(() => parseKnowledgePromoGrant(input, context)).toThrow(KnowledgeContractError)
})
