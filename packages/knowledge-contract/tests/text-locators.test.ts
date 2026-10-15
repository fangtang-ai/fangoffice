import { describe, expect, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeLocator } from '../src'
import { baseLocator, locatorContext } from './locator-fixtures'

const docx = {
  ...baseLocator,
  format: 'docx',
  headingPath: ['第一章', '适用范围'],
  blockIndex: 2,
  table: null,
}
const lines = { unit: 'line', origin: 1, boundary: 'inclusive', start: 3, end: 5 }

describe('DOCX structural locations, never fabricated pages', () => {
  it('keeps heading/block identity and optional physical table coordinates', () => {
    expect(parseKnowledgeLocator(docx, locatorContext('docx'))).toEqual(docx)
    const table = { unit: 'table_cell', origin: 1, tableIndex: 0, row: 2, column: 3 }
    expect(parseKnowledgeLocator({ ...docx, table }, locatorContext('docx'))).toEqual({
      ...docx,
      table,
    })
  })

  it.each([
    { ...docx, page: 1 },
    { ...docx, physicalPage: 1 },
    { ...docx, blockIndex: -1 },
    { ...docx, headingPath: Array(33).fill('层级') },
    { ...docx, headingPath: [''] },
    { ...docx, table: { unit: 'table_cell', origin: 1, tableIndex: 0, row: 0, column: 1 } },
    { ...docx, table: { unit: 'table_cell', origin: 0, tableIndex: 0, row: 1, column: 1 } },
  ])('rejects false pagination or invalid structure: %j', (input) => {
    expect(() => parseKnowledgeLocator(input, locatorContext('docx'))).toThrow(
      KnowledgeContractError,
    )
  })
})

describe('Markdown/TXT line and original-text ranges', () => {
  it.each(['md', 'txt'] as const)(
    'preserves %s lines separately from code-point offsets',
    (format) => {
      const locator = { ...baseLocator, format, headingPath: ['章节'], lines }
      expect(parseKnowledgeLocator(locator, locatorContext(format))).toEqual(locator)
      const oneLine = { ...locator, lines: { ...lines, start: 3, end: 3 } }
      expect(parseKnowledgeLocator(oneLine, locatorContext(format))).toEqual(oneLine)
    },
  )

  it.each([
    { ...lines, start: 0 },
    { ...lines, start: 6, end: 5 },
    { ...lines, end: 1.5 },
    { ...lines, origin: 0 },
    { ...lines, boundary: 'half_open' },
    { ...lines, unit: 'byte' },
  ])('rejects unclear line conventions: %j', (lineRange) => {
    expect(() =>
      parseKnowledgeLocator(
        { ...baseLocator, format: 'md', headingPath: [], lines: lineRange },
        locatorContext('md'),
      ),
    ).toThrow(KnowledgeContractError)
  })

  it('does not accept cleaned UTF-16 offsets as original code-point locations', () => {
    const locator = {
      ...baseLocator,
      format: 'txt',
      headingPath: [],
      lines,
      span: { ...baseLocator.span, unit: 'utf16' },
    }
    expect(() => parseKnowledgeLocator(locator, locatorContext('txt'))).toThrow(
      KnowledgeContractError,
    )
  })
})
