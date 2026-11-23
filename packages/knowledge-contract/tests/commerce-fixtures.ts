export function fixtureId(suffix: number) {
  return `019a1234-0000-7000-8000-${String(suffix).padStart(12, '0')}`
}

export const now = '2026-10-15T00:00:00.000Z'
export const later = '2026-10-15T01:00:00.000Z'
export const storageWindow = {
  kind: 'storage_window',
  windowId: fixtureId(1),
  startAt: '2026-10-13T16:00:00.000Z',
  endAt: '2026-10-14T16:00:00.000Z',
  timezone: 'Asia/Shanghai',
  openingSequence: '9007199254740993',
  closingSequence: '9007199254740995',
  eventSetHash: 'a'.repeat(64),
}

export const storageEvent = {
  schemaVersion: 1,
  id: fixtureId(2),
  eventKey: 'synthetic-storage-window-1',
  product: 'knowledge_base',
  occurredAt: now,
  eventType: 'observation',
  supersedesEventId: null,
  tariffRevision: 'synthetic-tariff-1',
  payer: 'customer',
  dimension: 'storage',
  subject: storageWindow,
  usage: { source: 'reconciled', quantity: { unit: 'byte_ms', value: '9223372036854775808' } },
}

export const querySubject = { kind: 'query', runId: fixtureId(3), callId: fixtureId(4) }
export const operationSubject = {
  kind: 'operation',
  spaceId: fixtureId(5),
  documentId: fixtureId(6),
  operationId: fixtureId(7),
  versionId: fixtureId(8),
  buildId: fixtureId(9),
}
export const embeddingEvent = {
  ...storageEvent,
  id: fixtureId(10),
  eventKey: 'synthetic-query-call-1',
  dimension: 'embedding',
  subject: querySubject,
  attemptId: fixtureId(11),
  indexProfileId: fixtureId(12),
  purpose: 'query',
  callState: 'completed',
  completion: 'evidence_complete',
  usage: { source: 'provider_reported', quantity: { unit: 'tokens', value: '17' } },
}

export const embeddingSettlement = {
  schemaVersion: 1,
  product: 'knowledge_base',
  settlementKey: 'synthetic-embedding-settlement-1',
  tariffRevision: 'synthetic-tariff-1',
  dimension: 'embedding',
  quantity: { unit: 'tokens', value: '17' },
  coverage: { kind: 'events', eventIds: [embeddingEvent.id], eventSetHash: 'b'.repeat(64) },
}
export const pendingReceipt = {
  schemaVersion: 1,
  settlement: embeddingSettlement,
  status: 'pending',
  siteReceiptId: null,
  confirmedAt: null,
  amounts: null,
}

export const settledReceipt = {
  ...pendingReceipt,
  status: 'settled',
  siteReceiptId: fixtureId(30),
  confirmedAt: now,
  amounts: {
    reservedFen: '9007199254740993',
    capturedFen: '9007199254740992',
    releasedFen: '1',
    carryInFen: '0.9',
    carryOutFen: '0.000000000000000001',
  },
}

export const estimatedBudget = {
  schemaVersion: 1,
  id: fixtureId(40),
  product: 'knowledge_base',
  dimension: 'embedding',
  purpose: 'document',
  scopeHash: 'c'.repeat(64),
  policyRevision: 'synthetic-budget-policy-1',
  tariffRevision: 'synthetic-tariff-1',
  issuedAt: now,
  expiresAt: later,
  status: 'estimated',
  estimatedQuantity: { unit: 'tokens', value: '17' },
  maxQuantity: { unit: 'tokens', value: '20' },
  maxChargeFen: '100',
  reservation: null,
  confirmationId: null,
}
export const budgetContext = {
  scopeHash: estimatedBudget.scopeHash,
  purpose: 'document',
  policyRevision: estimatedBudget.policyRevision,
  tariffRevision: estimatedBudget.tariffRevision,
  confirmationId: null,
  now,
}

export const promoGrant = {
  schemaVersion: 1,
  product: 'knowledge_base',
  grantType: 'new_user_grant',
  source: 'promotional',
  grantId: fixtureId(50),
  grantRevision: 'synthetic-grant-v1',
  creditedFen: '100',
  grantedAt: now,
  expiresAt: null,
  expiryRulesRevision: null,
}
export const promoContext = {
  eligibility: 'eligible',
  policy: {
    grantRevision: promoGrant.grantRevision,
    creditedFen: promoGrant.creditedFen,
    expiresAt: null,
    expiryRulesRevision: null,
  },
  existingGrant: null,
  now,
}
