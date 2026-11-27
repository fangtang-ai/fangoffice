import {
  choice,
  counter,
  invalid,
  literal,
  object,
  record,
  timestamp,
  uuid,
  type Decoder,
} from '../validation.js'
import { empty, matchSnapshot } from './common.js'
import { parseKnowledgeSettlementSnapshot } from './settlement.js'

const fields = {
  schemaVersion: literal(1),
  settlement: parseKnowledgeSettlementSnapshot,
}
const pending = object({
  ...fields,
  status: choice(['pending', 'reconciling']),
  siteReceiptId: empty,
  confirmedAt: empty,
  amounts: empty,
})
const remainder: Decoder<string> = (input, path) => {
  if (typeof input !== 'string' || !/^(0|0\.[0-9]{0,17}[1-9])$/.test(input)) invalid(path)
  return input
}
const confirmed = object({
  ...fields,
  status: choice(['reserved', 'settled', 'released']),
  siteReceiptId: uuid,
  confirmedAt: timestamp,
  amounts: object({
    reservedFen: counter,
    capturedFen: counter,
    releasedFen: counter,
    carryInFen: remainder,
    carryOutFen: remainder,
  }),
})

function decodeReceipt(input: unknown) {
  const status = record(input, 'billingReceipt').status
  if (status === 'pending' || status === 'reconciling') return pending(input, 'billingReceipt')
  const result = confirmed(input, 'billingReceipt')
  const amounts = result.amounts
  // These are website-reported integer-fen facts, not a second pricing or wallet engine.
  if (result.status === 'reserved') {
    if (amounts.capturedFen !== '0' || amounts.releasedFen !== '0')
      invalid('billingReceipt.amounts')
  } else if (
    BigInt(amounts.capturedFen) + BigInt(amounts.releasedFen) !==
    BigInt(amounts.reservedFen)
  ) {
    invalid('billingReceipt.amounts')
  }
  if (result.status === 'released' && amounts.capturedFen !== '0') invalid('billingReceipt.amounts')
  if (result.status !== 'settled' && amounts.carryInFen !== amounts.carryOutFen)
    invalid('billingReceipt.amounts.carryOutFen')
  return result
}

export function parseKnowledgeBillingReceipt(input: unknown, expected: unknown) {
  const snapshot = parseKnowledgeSettlementSnapshot(expected)
  const result = decodeReceipt(input)
  matchSnapshot(result.settlement, snapshot, 'billingReceipt.settlement')
  return result
}

export type KnowledgeBillingReceipt = ReturnType<typeof parseKnowledgeBillingReceipt>
