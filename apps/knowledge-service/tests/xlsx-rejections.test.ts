import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { parseKnowledgeXlsxDocument } from '../src/parsing'
import { selectedXlsx, workbookParts, xlsxLimits, xlsxZip } from './xlsx-fixtures'

it.each([
  '<c r="A1" t="s"><v>77</v></c>',
  '<c r="A1" t="b"><v>2</v></c>',
  '<c r="A1" s="999"><v>1</v></c>',
  '<c r="A1"><v>one</v></c>',
  '<c r="A1"><v>1</v><v>2</v></c>',
])('rejects cells with unresolved or contradictory value metadata', (cells) => {
  const input = selectedXlsx(workbookParts(`<sheetData><row r="1">${cells}</row></sheetData>`))
  expect(() => parseKnowledgeXlsxDocument(input, xlsxLimits)).toThrow('CORRUPT_CONTAINER')
})

it('rejects DTDs and malformed XML at preflight instead of expanding entities', () => {
  const valid = selectedXlsx(
    workbookParts('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'),
  )
  for (const sheet of [
    '<!DOCTYPE worksheet [<!ENTITY secret "EXPANDED">]><worksheet><sheetData/></worksheet>',
    '<worksheet><sheetData></worksheet>',
  ]) {
    const source = xlsxZip(workbookParts('', { 'xl/worksheets/sheet1.xml': sheet }))
    const snapshot = { ...valid.snapshot, sourceHash: source.sourceHash }
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    expect(() =>
      parseKnowledgeXlsxDocument({ ...source, snapshot, snapshotHash }, xlsxLimits),
    ).toThrow('CORRUPT_CONTAINER')
  }
})

it('rejects overlapping merged ranges instead of arbitrarily choosing an anchor', () => {
  const input = selectedXlsx(
    workbookParts(
      '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/><mergeCell ref="B1:C1"/></mergeCells>',
    ),
  )
  expect(() => parseKnowledgeXlsxDocument(input, xlsxLimits)).toThrow('CORRUPT_CONTAINER')
})

it('bounds aggregate decompressed XML rather than only the largest individual entry', () => {
  const parts = workbookParts('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>', {
    'xl/unused.xml': '<unused>' + 'x'.repeat(2000) + '</unused>',
  })
  const input = selectedXlsx(parts)
  expect(() => parseKnowledgeXlsxDocument(input, { ...xlsxLimits, maxXmlBytes: 2100 })).toThrow(
    'LIMIT_EXCEEDED',
  )
})

it('decodes SpreadsheetML escaped characters while preserving escaped underscores and surrogate pairs', () => {
  const input = selectedXlsx(
    workbookParts(
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>line_x000A__xD83D__xDE00__x005F_x0041_</t></is></c></row></sheetData>',
    ),
  )
  const cell = parseKnowledgeXlsxDocument(input, xlsxLimits).units[0]!.cells[0]!
  expect(cell.raw).toBe('line_x000A__xD83D__xDE00__x005F_x0041_')
  expect(cell.value).toBe('line\n😀_x0041_')
})

it('reads ISO date cells and fractional numeric literals without guessing their type', () => {
  const input = selectedXlsx(
    workbookParts(
      '<sheetData><row r="1"><c r="A1" t="d"><v>2026-10-15</v></c><c r="B1"><v>.5</v></c></row></sheetData>',
    ),
  )
  const cells = parseKnowledgeXlsxDocument(input, xlsxLimits).units[0]!.cells
  expect(cells[0]).toMatchObject({ type: 'date', raw: '2026-10-15', display: '2026-10-15' })
  expect(cells[1]).toMatchObject({ type: 'number', raw: '.5', value: '.5' })
})

it('rejects control characters and unpaired surrogate escapes instead of emitting broken text', () => {
  for (const text of ['_x0001_', '_xD83D_']) {
    const input = selectedXlsx(
      workbookParts(
        `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData>`,
      ),
    )
    expect(() => parseKnowledgeXlsxDocument(input, xlsxLimits)).toThrow('BINARY_CONTENT')
  }
})
