import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  KnowledgeContractError,
  parseKnowledgeCodePointRange,
  sliceKnowledgeCodePoints,
} from '../src'

const span = { unit: 'unicode_code_point', origin: 0, start: 1, end: 2 }

describe('explicit Unicode code-point half-open ranges', () => {
  it('counts a non-BMP character once without confusing code points with graphemes', () => {
    expect(parseKnowledgeCodePointRange(span)).toEqual(span)
    expect(sliceKnowledgeCodePoints('甲😀e\u0301乙', span)).toBe('😀')
    expect(sliceKnowledgeCodePoints('甲😀e\u0301乙', { ...span, start: 2, end: 4 })).toBe('e\u0301')
    expect(sliceKnowledgeCodePoints('甲😀e\u0301乙', { ...span, start: 0, end: 5 })).toBe(
      '甲😀e\u0301乙',
    )
    expectTypeOf(parseKnowledgeCodePointRange(span).origin).toEqualTypeOf<0>()
    expectTypeOf(parseKnowledgeCodePointRange(span).unit).toEqualTypeOf<'unicode_code_point'>()
  })

  it.each([
    { ...span, unit: 'utf16' },
    { ...span, origin: 1 },
    { ...span, start: -1 },
    { ...span, start: 1.5 },
    { ...span, start: '1' },
    { ...span, start: 2, end: 2 },
    { ...span, start: 3, end: 2 },
    { ...span, end: 2147483648 },
    { ...span, owner: 'forged' },
  ])('rejects ambiguous or invalid offsets: %j', (value) => {
    expect(() => parseKnowledgeCodePointRange(value)).toThrow(KnowledgeContractError)
  })

  it('rejects out-of-source ranges rather than silently truncating an excerpt', () => {
    expect(() => sliceKnowledgeCodePoints('甲😀', { ...span, end: 3 })).toThrow(
      KnowledgeContractError,
    )
    expect(() => sliceKnowledgeCodePoints('', span)).toThrow(KnowledgeContractError)
    expect(() => sliceKnowledgeCodePoints(null, span)).toThrow(KnowledgeContractError)
  })
})
