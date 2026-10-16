import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { parseKnowledgeCoverage, parseKnowledgeLocator } from '@genoffice/knowledge-contract'
import { parseKnowledgeXlsxDocument } from '../src/parsing'
import { selectedXlsx, workbookParts, xlsxLimits } from './xlsx-fixtures'

it('reads source-bound selected rows without losing leading zeroes or physical cell coordinates', () => {
  const input = selectedXlsx(
    workbookParts(
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>编号</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>00123😀</t></is></c></row></sheetData>',
    ),
  )
  const document = parseKnowledgeXlsxDocument(input, xlsxLimits)
  expect(document).toMatchObject({
    format: 'xlsx',
    sourceHash: input.sourceHash,
    selectionHash: input.snapshotHash,
  })
  expect(document.units).toHaveLength(2)
  const row = document.units[1]!
  expect(row).toMatchObject({ row: 2, sheetId: '1', sheetName: '明细' })
  expect(row.cells).toHaveLength(1)
  expect(row.cells[0]).toMatchObject({
    row: 2,
    column: 1,
    a1: 'A2',
    raw: '00123😀',
    value: '00123😀',
    display: '00123😀',
    type: 'text',
    formula: null,
  })
  expect(row.headers[0]).toMatchObject({ a1: 'A1', value: '编号' })
  expect(row.locator.a1).toBe('A2')
  expect(
    parseKnowledgeLocator(row.locator, {
      format: 'xlsx',
      sourceHash: input.sourceHash,
      textHash: row.textHash,
      textCodePointLength: [...row.text].length,
    }),
  ).toEqual(row.locator)
  expect(
    parseKnowledgeCoverage(document.coverage, {
      format: 'xlsx',
      sourceHash: input.sourceHash,
      parserRevision: document.parserRevision,
    }),
  ).toMatchObject({
    scope: 'selection',
    unit: 'cell',
    status: 'complete',
    expectedUnits: 2,
    completedUnits: 2,
    missingUnits: 0,
  })
})

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

it('rejects changed bytes, mismatched hashes and forged snapshot metadata', () => {
  const input = selectedXlsx(
    workbookParts('<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>'),
  )
  expect(() =>
    parseKnowledgeXlsxDocument({ ...input, bytes: new Uint8Array(input.bytes.length) }, xlsxLimits),
  ).toThrow('SOURCE_MISMATCH')
  expect(() =>
    parseKnowledgeXlsxDocument({ ...input, snapshotHash: 'a'.repeat(64) }, xlsxLimits),
  ).toThrow('SOURCE_MISMATCH')
  const snapshot = { ...input.snapshot, dateSystem: '1904' }
  expect(() =>
    parseKnowledgeXlsxDocument({ ...input, snapshot, snapshotHash: digest(snapshot) }, xlsxLimits),
  ).toThrow('SOURCE_MISMATCH')
})

const hiddenParts = () =>
  workbookParts(
    '<cols><col min="2" max="2" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>公开</t></is></c><c r="B1" t="inlineStr"><is><t>秘密列</t></is></c><c r="C1"><v>1</v></c></row><row r="2" hidden="true"><c r="A2" t="inlineStr"><is><t>秘密行</t></is></c></row><row r="3"><c r="A3"><v>3</v></c><c r="C3"><v>4</v></c></row></sheetData>',
  )

it('excludes every hidden row and column by default and reports honest selection coverage', () => {
  const document = parseKnowledgeXlsxDocument(selectedXlsx(hiddenParts()), xlsxLimits)
  expect(document.units.flatMap((row) => row.cells.map((cell) => cell.a1))).toEqual([
    'A1',
    'C1',
    'A3',
    'C3',
  ])
  expect(JSON.stringify(document)).not.toContain('秘密')
  expect(document.coverage).toMatchObject({
    scope: 'selection',
    completedUnits: 4,
    excludedUnits: 2,
  })
  expect(document.coverage.warnings).toContainEqual({
    code: 'HIDDEN_CONTENT_EXCLUDED',
    unitOrdinal: null,
  })
})

it('includes hidden content only when it is explicitly frozen into the selection', () => {
  const input = selectedXlsx(hiddenParts(), {
    includeHiddenContent: true,
    sheets: [{ sheetId: 1 }],
  })
  expect(parseKnowledgeXlsxDocument(input, xlsxLimits).text).toContain('秘密行')
})

it('accepts namespaced worksheets and trailing XML whitespace through the same preflight seam', () => {
  const parts = workbookParts('<sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData>')
  parts['xl/worksheets/sheet1.xml'] =
    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>9</x:v></x:c></x:row></x:sheetData></x:worksheet>\n'
  expect(parseKnowledgeXlsxDocument(selectedXlsx(parts), xlsxLimits).units[0]?.cells[0]?.raw).toBe(
    '9',
  )
})

it('keeps sparse physical coordinates without expanding a million blank rows', () => {
  const input = selectedXlsx(
    workbookParts('<sheetData><row r="1000000"><c r="ZZ1000000"><v>12</v></c></row></sheetData>'),
    {
      includeHiddenContent: false,
      sheets: [
        {
          sheetId: 1,
          range: { startRow: 1000000, endRow: 1000000, startColumn: 702, endColumn: 702 },
        },
      ],
    },
  )
  const document = parseKnowledgeXlsxDocument(input, {
    ...xlsxLimits,
    maxRowsPerSheet: 1,
    maxColumnsPerSheet: 1,
  })
  expect(document.units).toHaveLength(1)
  expect(document.units[0]?.locator.a1).toBe('ZZ1000000')
})
