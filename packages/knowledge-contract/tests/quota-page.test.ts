import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  KnowledgeContractError,
  parseKnowledgePage,
  parseKnowledgePagination,
  parseKnowledgeQuota,
  parseKnowledgeSpace,
} from '../src'

const spaceId = '019a1234-0000-7000-8000-000000000001'
const otherSpaceId = '019a1234-0000-7000-8000-000000000002'
const quota = {
  ownerState: 'active',
  activeIndexProfileId: '019a1234-0000-7000-8000-000000000007',
  policyRevision: 'synthetic-test-policy-1',
  updatedAt: '2026-10-14T00:00:00.000Z',
  limits: { files: '50', bytes: '209715200', chunks: '2000' },
  active: { files: '2', bytes: '1024', chunks: '8' },
  reserved: { files: '1', bytes: '512', chunks: '4' },
  physical: {
    accountedBytes: '9007199254740993',
    reservedBytes: '1024',
    limitBytes: '9223372036854775807',
  },
}
const spaces = [
  { id: spaceId, title: '资料一', state: 'active' },
  { id: otherSpaceId, title: '资料二', state: 'active' },
]
const request = parseKnowledgePagination({ limit: 2 })

describe('quota snapshots, not billing or admission', () => {
  it('preserves active/reserved/physical counters as lossless strings', () => {
    expect(parseKnowledgeQuota(quota)).toEqual(quota)
    expectTypeOf(parseKnowledgeQuota(quota).physical.accountedBytes).toBeString()
  })

  it('does not reject an existing over-limit account after a policy downgrade', () => {
    const downgraded = { ...quota, limits: { files: '1', bytes: '512', chunks: '4' } }
    expect(parseKnowledgeQuota(downgraded)).toEqual(downgraded)
  })

  it('represents missing policy explicitly instead of inventing free or zero quota', () => {
    const unavailable = { ...quota, policyRevision: null, activeIndexProfileId: null, limits: null }
    expect(parseKnowledgeQuota(unavailable)).toEqual(unavailable)
  })

  it.each([
    { ...quota, ownerState: 'ready' },
    { ...quota, policyRevision: null },
    { ...quota, limits: null },
    { ...quota, activeIndexProfileId: null },
    { ...quota, active: { ...quota.active, bytes: '-1' } },
    { ...quota, reserved: { ...quota.reserved, files: 1 } },
    { ...quota, ownerId: 'forged' },
    { ...quota, balanceCny: '1000' },
  ])('rejects invalid counters, policy snapshots or financial fields: %j', (value) => {
    expect(() => parseKnowledgeQuota(value)).toThrow(KnowledgeContractError)
  })
})

describe('bounded and validated list responses', () => {
  it('validates every item and a last-item UUID cursor using the requested limit', () => {
    const page = { items: spaces, nextCursor: otherSpaceId }
    expect(parseKnowledgePage(page, parseKnowledgeSpace, request)).toEqual(page)
    expectTypeOf(
      parseKnowledgePage(page, parseKnowledgeSpace, request).items[0].state,
    ).toEqualTypeOf<'active' | 'frozen' | 'deleting' | 'deleted'>()
    expect(
      parseKnowledgePage({ items: [], nextCursor: null }, parseKnowledgeSpace, request),
    ).toEqual({ items: [], nextCursor: null })
  })

  it.each([
    { items: spaces, nextCursor: spaceId },
    { items: [], nextCursor: spaceId },
    { items: [spaces[0], spaces[0]], nextCursor: null },
    { items: [spaces[0], { ...spaces[1], owner: 'forged' }], nextCursor: null },
    { items: Array(2), nextCursor: null },
    { items: spaces, nextCursor: '../other' },
    { items: spaces, nextCursor: null, total: 1000 },
  ])('rejects malformed items, cursors and extra metadata: %j', (value) => {
    expect(() => parseKnowledgePage(value, parseKnowledgeSpace, request)).toThrow(
      KnowledgeContractError,
    )
  })

  it('enforces requested page size, not just the global maximum', () => {
    expect(() =>
      parseKnowledgePage({ items: spaces, nextCursor: null }, parseKnowledgeSpace, {
        limit: 1,
        cursor: null,
      }),
    ).toThrow(KnowledgeContractError)
  })
})
