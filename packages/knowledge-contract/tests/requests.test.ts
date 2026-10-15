import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  KnowledgeContractError,
  parseKnowledgeDocumentInput,
  parseKnowledgeDocumentTarget,
  parseKnowledgeMutationTarget,
  parseKnowledgePagination,
  parseKnowledgeScope,
  parseKnowledgeSpaceInput,
} from '../src'

const spaceId = '019a1234-0000-7000-8000-000000000001'
const otherSpaceId = '019a1234-0000-7000-8000-000000000002'
const documentId = '019a1234-0000-7000-8000-000000000003'
const target = { spaceId, documentId }

describe('shared management inputs', () => {
  it('parses titles, bounded metadata and condition generations without transport coercion', () => {
    expect(parseKnowledgeSpaceInput({ title: '资料' })).toEqual({ title: '资料' })
    const metadata = { title: '合同范本', tags: ['合同'], purpose: 'template' }
    expect(parseKnowledgeDocumentInput(metadata)).toEqual(metadata)
    expect(parseKnowledgeDocumentTarget(target)).toEqual(target)
    expect(
      parseKnowledgeMutationTarget({ ...target, expectedGeneration: '9007199254740993' }),
    ).toEqual({ ...target, expectedGeneration: '9007199254740993' })
    expectTypeOf(parseKnowledgeDocumentInput(metadata).purpose).toEqualTypeOf<
      'facts' | 'style' | 'template'
    >()
  })

  it.each(['owner', 'ownerId', 'owner_id', 'userId', 'token', 'url'])(
    'rejects caller-controlled %s across all input seams',
    (key) => {
      expect(() => parseKnowledgeSpaceInput({ title: '资料', [key]: 'forged' })).toThrow(
        KnowledgeContractError,
      )
      expect(() => parseKnowledgeDocumentTarget({ ...target, [key]: 'forged' })).toThrow(
        KnowledgeContractError,
      )
      expect(() =>
        parseKnowledgeScope({ kind: 'spaces', spaceIds: [spaceId], [key]: 'forged' }),
      ).toThrow(KnowledgeContractError)
    },
  )

  it.each([0, -1, 1.5, '01', '-1', '1e3', '9223372036854775808', undefined])(
    'rejects invalid generation %j',
    (expectedGeneration) => {
      expect(() => parseKnowledgeMutationTarget({ ...target, expectedGeneration })).toThrow(
        KnowledgeContractError,
      )
    },
  )

  it.each([
    { title: '', tags: [], purpose: 'facts' },
    { title: 'x'.repeat(201), tags: [], purpose: 'facts' },
    { title: '资料', tags: ['同名', '同名'], purpose: 'facts' },
    { title: '资料', tags: ['x'.repeat(51)], purpose: 'facts' },
    { title: '资料', tags: Array.from({ length: 21 }, (_, index) => `${index}`), purpose: 'facts' },
    { title: '资料', tags: [], purpose: 'instruction' },
  ])('rejects unbounded or instruction-like metadata: %j', (value) => {
    expect(() => parseKnowledgeDocumentInput(value)).toThrow(KnowledgeContractError)
  })
})

describe('bounded selection scope', () => {
  it('keeps explicit space and document selections distinct', () => {
    const spaces = { kind: 'spaces', spaceIds: [spaceId] }
    const documents = { kind: 'documents', documents: [target] }
    expect(parseKnowledgeScope(spaces)).toEqual(spaces)
    expect(parseKnowledgeScope(documents)).toEqual(documents)
    expectTypeOf(parseKnowledgeScope(documents).kind).toEqualTypeOf<'spaces' | 'documents'>()
  })

  it.each([
    { kind: 'all' },
    { kind: 'spaces', spaceIds: [] },
    { kind: 'spaces', spaceIds: [spaceId, spaceId] },
    { kind: 'spaces', spaceIds: Array(51).fill(spaceId) },
    { kind: 'documents', documents: [] },
    { kind: 'documents', documents: [target, { spaceId: otherSpaceId, documentId }] },
    { kind: 'documents', documents: [{ ...target, versionId: spaceId }] },
    { kind: 'spaces', spaceIds: [spaceId], documents: [target] },
  ])('rejects empty, duplicate or ambiguous parent scopes: %j', (value) => {
    expect(() => parseKnowledgeScope(value)).toThrow(KnowledgeContractError)
  })
})

describe('HTTP query and IPC pagination', () => {
  it('shares defaults and accepts canonical HTTP digits or IPC integers', () => {
    expect(parseKnowledgePagination({})).toEqual({ limit: 20, cursor: null })
    expect(parseKnowledgePagination({ limit: '100', cursor: documentId })).toEqual({
      limit: 100,
      cursor: documentId,
    })
    expect(parseKnowledgePagination({ limit: 1 })).toEqual({ limit: 1, cursor: null })
  })

  it.each([0, -1, 101, 1.5, NaN, Infinity, '01', '1e2', ' 20', '20 ', '', null, []])(
    'rejects noncanonical or out-of-range limit %j',
    (limit) => expect(() => parseKnowledgePagination({ limit })).toThrow(KnowledgeContractError),
  )

  it.each(['../other', '', { id: documentId }])('rejects arbitrary cursor %j', (cursor) => {
    expect(() => parseKnowledgePagination({ cursor })).toThrow(KnowledgeContractError)
  })
})
