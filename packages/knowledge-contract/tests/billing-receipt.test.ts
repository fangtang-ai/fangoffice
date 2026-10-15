import { expect, expectTypeOf, it } from 'vitest'
import {
  KnowledgeContractError,
  parseKnowledgeBillingReceipt,
  parseKnowledgeSettlementSnapshot,
} from '../src'
import {
  embeddingSettlement,
  fixtureId,
  now,
  pendingReceipt,
  settledReceipt,
  storageWindow,
} from './commerce-fixtures'

it('keeps unconfirmed settlement pending without claiming zero charge or release', () => {
  expect(parseKnowledgeBillingReceipt(pendingReceipt, embeddingSettlement)).toEqual(pendingReceipt)
})

it('keeps large integer fen and sub-fen carry as strings in a confirmed receipt', () => {
  expect(parseKnowledgeBillingReceipt(settledReceipt, embeddingSettlement)).toEqual(settledReceipt)
})

it('supports daily storage windows without inventing a file operation', () => {
  const snapshot = {
    ...embeddingSettlement,
    dimension: 'storage',
    quantity: { unit: 'byte_ms', value: '9223372036854775808' },
    coverage: storageWindow,
  }
  expect(parseKnowledgeSettlementSnapshot(snapshot)).toEqual(snapshot)
})

it.each([
  { label: 'reconciling', input: { ...pendingReceipt, status: 'reconciling' } },
  {
    label: 'reserved',
    input: {
      ...settledReceipt,
      status: 'reserved',
      amounts: {
        ...settledReceipt.amounts,
        capturedFen: '0',
        releasedFen: '0',
        carryOutFen: '0.9',
      },
    },
  },
  {
    label: 'released',
    input: {
      ...settledReceipt,
      status: 'released',
      amounts: {
        ...settledReceipt.amounts,
        capturedFen: '0',
        releasedFen: settledReceipt.amounts.reservedFen,
        carryOutFen: '0.9',
      },
    },
  },
  {
    label: 'zero charge without minimum fen',
    input: {
      ...settledReceipt,
      amounts: {
        ...settledReceipt.amounts,
        capturedFen: '0',
        releasedFen: settledReceipt.amounts.reservedFen,
      },
    },
  },
])('preserves $label state without guessing a debit', ({ input }) => {
  expect(parseKnowledgeBillingReceipt(input, embeddingSettlement)).toEqual(input)
})

it('narrows pending amounts to null rather than zero', () => {
  const result = parseKnowledgeBillingReceipt(pendingReceipt, embeddingSettlement)
  if (result.status === 'pending') expectTypeOf(result.amounts).toEqualTypeOf<null>()
})

it.each([
  {
    label: 'settlement key drift',
    input: { ...pendingReceipt, settlement: { ...embeddingSettlement, settlementKey: 'other' } },
  },
  {
    label: 'tariff drift',
    input: { ...pendingReceipt, settlement: { ...embeddingSettlement, tariffRevision: 'other' } },
  },
  {
    label: 'quantity drift',
    input: {
      ...pendingReceipt,
      settlement: { ...embeddingSettlement, quantity: { unit: 'tokens', value: '18' } },
    },
  },
  {
    label: 'event drift',
    input: {
      ...pendingReceipt,
      settlement: {
        ...embeddingSettlement,
        coverage: { ...embeddingSettlement.coverage, eventIds: [fixtureId(99)] },
      },
    },
  },
  { label: 'missing confirmation', input: { ...settledReceipt, confirmedAt: null } },
  { label: 'pending claims funds', input: { ...pendingReceipt, amounts: settledReceipt.amounts } },
  { label: 'reconciling claims confirmation', input: { ...settledReceipt, status: 'reconciling' } },
  { label: 'reserved claims debit', input: { ...settledReceipt, status: 'reserved' } },
  { label: 'released claims debit', input: { ...settledReceipt, status: 'released' } },
  {
    label: 'funds not conserved',
    input: { ...settledReceipt, amounts: { ...settledReceipt.amounts, releasedFen: '2' } },
  },
  {
    label: 'floating fen',
    input: { ...settledReceipt, amounts: { ...settledReceipt.amounts, capturedFen: 1 } },
  },
  {
    label: 'fractional captured fen',
    input: { ...settledReceipt, amounts: { ...settledReceipt.amounts, capturedFen: '0.1' } },
  },
  {
    label: 'carry over one fen',
    input: { ...settledReceipt, amounts: { ...settledReceipt.amounts, carryOutFen: '1' } },
  },
  {
    label: 'carry overflow',
    input: {
      ...settledReceipt,
      amounts: { ...settledReceipt.amounts, carryOutFen: '0.0000000000000000001' },
    },
  },
  {
    label: 'exponent carry',
    input: { ...settledReceipt, amounts: { ...settledReceipt.amounts, carryOutFen: '1e-9' } },
  },
  { label: 'forged balance', input: { ...settledReceipt, balanceFen: '1000' } },
  { label: 'missing site receipt', input: { ...settledReceipt, siteReceiptId: null } },
])('rejects receipt $label', ({ input }) => {
  expect(() => parseKnowledgeBillingReceipt(input, embeddingSettlement)).toThrow(
    KnowledgeContractError,
  )
})

it.each([
  {
    label: 'duplicate event',
    input: {
      ...embeddingSettlement,
      coverage: { ...embeddingSettlement.coverage, eventIds: [fixtureId(1), fixtureId(1)] },
    },
  },
  {
    label: 'empty set',
    input: { ...embeddingSettlement, coverage: { ...embeddingSettlement.coverage, eventIds: [] } },
  },
  {
    label: 'unbounded set',
    input: {
      ...embeddingSettlement,
      coverage: {
        ...embeddingSettlement.coverage,
        eventIds: Array.from({ length: 1001 }, (_, index) => fixtureId(index + 1)),
      },
    },
  },
  {
    label: 'unit mismatch',
    input: { ...embeddingSettlement, quantity: { unit: 'byte_ms', value: '17' } },
  },
  { label: 'wrong product', input: { ...embeddingSettlement, product: 'office_ai' } },
  { label: 'fake confirmation', input: { ...embeddingSettlement, confirmedAt: now } },
])('rejects settlement $label', ({ input }) => {
  expect(() => parseKnowledgeSettlementSnapshot(input)).toThrow(KnowledgeContractError)
})
