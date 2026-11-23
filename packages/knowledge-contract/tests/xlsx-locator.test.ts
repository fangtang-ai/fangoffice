import { describe, expect, expectTypeOf, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeLocator, type KnowledgeVersion } from '../src'
import { baseLocator, locatorContext } from './locator-fixtures'

const range = {
  unit: 'cell',
  origin: 1,
  boundary: 'inclusive',
  startRow: 3,
  endRow: 4,
  startColumn: 2,
  endColumn: 3,
}
const xlsx = {
  ...baseLocator,
  format: 'xlsx',
  sheetId: 'sheet-42',
  sheetName: '预算 原表',
  dateSystem: '1900',
  range,
  a1: 'B3:C4',
}
const context = locatorContext('xlsx')

describe('XLSX physical coordinates, not expanded sparse grids', () => {
  it('preserves original sheet identity, date system and matching physical A1 range', () => {
    const result = parseKnowledgeLocator(xlsx, context)
    expect(result).toEqual(xlsx)
    expect(parseKnowledgeLocator({ ...xlsx, dateSystem: '1904' }, context)).toEqual({
      ...xlsx,
      dateSystem: '1904',
    })
    expectTypeOf(result.format).toEqualTypeOf<KnowledgeVersion['format']>()
    if (result.format === 'xlsx') expectTypeOf(result.range.origin).toEqualTypeOf<1>()
  })

  it('uses physical bounds even when a selected cell is far beyond a small import window', () => {
    const lastCell = {
      ...xlsx,
      range: { ...range, startRow: 1048576, endRow: 1048576, startColumn: 16384, endColumn: 16384 },
      a1: 'XFD1048576',
    }
    expect(parseKnowledgeLocator(lastCell, context)).toEqual(lastCell)
    const columns = {
      ...xlsx,
      range: { ...range, startRow: 1, endRow: 2, startColumn: 26, endColumn: 27 },
      a1: 'Z1:AA2',
    }
    expect(parseKnowledgeLocator(columns, context)).toEqual(columns)
  })

  it.each([
    { ...xlsx, sheetId: '' },
    { ...xlsx, sheetName: 'x'.repeat(32) },
    { ...xlsx, dateSystem: 1900 },
    { ...xlsx, dateSystem: 'unix' },
    { ...xlsx, a1: 'A1:C4' },
    { ...xlsx, a1: 'b3:c4' },
    { ...xlsx, a1: '$B$3:$C$4' },
    { ...xlsx, a1: '预算 原表!B3:C4' },
    { ...xlsx, page: 1 },
    { ...xlsx, formula: '=WEBSERVICE("https://invalid.example")' },
  ])('rejects missing identity, guessed date systems or conflicting notation: %j', (input) => {
    expect(() => parseKnowledgeLocator(input, context)).toThrow(KnowledgeContractError)
  })

  it.each([
    { ...range, origin: 0 },
    { ...range, unit: 'px' },
    { ...range, boundary: 'half_open' },
    { ...range, startRow: 0 },
    { ...range, endRow: 1048577 },
    { ...range, endColumn: 16385 },
    { ...range, startRow: 5, endRow: 4 },
    { ...range, startColumn: 4, endColumn: 3 },
    { ...range, startColumn: 1.5 },
    { ...range, ownerId: 'forged' },
  ])('rejects invalid or ambiguous physical coordinates: %j', (coordinates) => {
    expect(() => parseKnowledgeLocator({ ...xlsx, range: coordinates }, context)).toThrow(
      KnowledgeContractError,
    )
  })
})
