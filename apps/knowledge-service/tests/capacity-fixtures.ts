import type { KnowledgeProductPolicy } from '../src'
import { ids, now, ownerId } from './fixtures'

export function productPolicy(overrides: Partial<KnowledgeProductPolicy> = {}) {
  return {
    product: 'knowledge_base' as const,
    ownerId,
    source: 'website' as const,
    revision: 'synthetic-policy-1',
    tariffRevision: 'synthetic-tariff-1',
    validFrom: now - 1000,
    validUntil: now + 60000,
    ...overrides,
  }
}

export function quota() {
  return {
    ownerState: 'active',
    activeIndexProfileId: ids.space,
    policyRevision: 'synthetic-policy-1',
    updatedAt: '2026-10-15T00:00:00.000Z',
    limits: { files: '10', bytes: '1000', chunks: '100' },
    active: { files: '5', bytes: '500', chunks: '50' },
    reserved: { files: '1', bytes: '100', chunks: '10' },
    physical: { accountedBytes: '1000', reservedBytes: '100', limitBytes: '2000' },
  }
}

export const projection = {
  next: { files: '1', bytes: '200', chunks: '20' },
  replaced: null,
  physicalBytes: '300',
}
