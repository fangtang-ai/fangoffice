import { expect, it } from 'vitest'
import { parseKnowledgeXlsxDocument } from '../src/parsing'
import { selectedXlsx, workbookParts, xlsxLimits } from './xlsx-fixtures'

it('retains merged header anchors and units as row context without duplicating covered cells', () => {
  const input = selectedXlsx(
    workbookParts(
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>金额（元）</t></is></c><c r="B1"/></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells>',
    ),
  )
  const document = parseKnowledgeXlsxDocument(input, xlsxLimits)
  expect(document.units[0]?.cells).toHaveLength(1)
  expect(document.units[0]?.cells[0]?.merge).toMatchObject({
    a1: 'A1:B1',
    anchor: 'A1',
    anchorAvailable: true,
  })
  expect(document.units[1]?.headers[0]).toMatchObject({
    value: '金额（元）',
    merge: { a1: 'A1:B1' },
  })
})

it('never imports a merged anchor or header from outside the frozen selection', () => {
  const input = selectedXlsx(
    workbookParts(
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>PRIVATE ANCHOR</t></is></c><c r="B1"/></row><row r="2"><c r="B2"><v>9</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells>',
    ),
    {
      includeHiddenContent: false,
      sheets: [{ sheetId: 1, range: { startRow: 1, endRow: 2, startColumn: 2, endColumn: 2 } }],
    },
  )
  const document = parseKnowledgeXlsxDocument(input, xlsxLimits)
  expect(JSON.stringify(document)).not.toContain('PRIVATE ANCHOR')
  expect(document.units[0]?.cells[0]?.merge).toMatchObject({ anchor: 'A1', anchorAvailable: false })
  expect(document.coverage.status).toBe('partial')
  expect(document.coverage.warnings).toContainEqual({ code: 'TABLE_INCOMPLETE', unitOrdinal: null })
})

it.each([
  {
    limit: 'maxRowsPerSheet',
    xml: '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>',
  },
  {
    limit: 'maxColumnsPerSheet',
    xml: '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>',
  },
  { limit: 'maxCells', xml: '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>' },
  {
    limit: 'maxCodePoints',
    xml: '<row r="1"><c r="A1" t="inlineStr"><is><t>too long</t></is></c></row>',
  },
])('fails instead of truncating when $limit is exceeded', ({ limit, xml }) => {
  const input = selectedXlsx(workbookParts(`<sheetData>${xml}</sheetData>`))
  expect(() => parseKnowledgeXlsxDocument(input, { ...xlsxLimits, [limit]: 1 })).toThrow(
    'LIMIT_EXCEEDED',
  )
})

it.each([
  '<row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>',
  '<row r="1"><c r="A2"><v>1</v></c></row>',
  '<row r="1"><c r="A1"><v>1</v></c></row><row r="1"><c r="B1"><v>2</v></c></row>',
])('rejects duplicate or contradictory physical coordinates', (rows) => {
  const input = selectedXlsx(workbookParts(`<sheetData>${rows}</sheetData>`))
  expect(() => parseKnowledgeXlsxDocument(input, xlsxLimits)).toThrow('CORRUPT_CONTAINER')
})

it('reports unsupported workbook content without executing macros or external links', () => {
  const input = selectedXlsx(
    workbookParts('<sheetData><row r="1"><c r="A1"><v>5</v></c></row></sheetData>', {
      'xl/vbaProject.bin': 'not executable',
      'xl/externalLinks/externalLink1.xml': '<externalLink/>',
    }),
  )
  const document = parseKnowledgeXlsxDocument(input, xlsxLimits)
  expect(document.coverage.status).toBe('partial')
  expect(document.coverage.warnings).toContainEqual({
    code: 'UNSUPPORTED_CONTENT',
    unitOrdinal: null,
  })
})

it('filters all hidden rows, not only the 1024 display examples retained by preflight', () => {
  const rows = Array.from(
    { length: 2058 },
    (_, index) =>
      `<row r="${index + 1}"${index % 2 === 0 ? ' hidden="1"' : ''}><c r="A${index + 1}" t="inlineStr"><is><t>${index % 2 === 0 ? 'PRIVATE' : 'PUBLIC'}</t></is></c></row>`,
  ).join('')
  const document = parseKnowledgeXlsxDocument(
    selectedXlsx(workbookParts(`<sheetData>${rows}</sheetData>`)),
    xlsxLimits,
  )
  expect(document.units).toHaveLength(1029)
  expect(document.text).not.toContain('PRIVATE')
  expect(document.units.at(-1)?.row).toBe(2058)
})

it('never serializes content or headers from an unselected worksheet', () => {
  const parts = workbookParts('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>', {
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>PRIVATE BODY</t></is></c></row></sheetData></worksheet>',
  })
  parts['xl/workbook.xml'] = parts['xl/workbook.xml'].replace(
    '</sheets>',
    '<sheet sheetId="2" name="PRIVATE NAME" r:id="r2"/></sheets>',
  )
  parts['xl/_rels/workbook.xml.rels'] = parts['xl/_rels/workbook.xml.rels'].replace(
    '</Relationships>',
    '<Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
  )
  const document = parseKnowledgeXlsxDocument(selectedXlsx(parts), xlsxLimits)
  expect(JSON.stringify(document)).not.toContain('PRIVATE')
  expect(document.coverage.excludedUnits).toBe(1)
  const input = selectedXlsx(parts, {
    includeHiddenContent: false,
    sheets: [{ sheetId: 1 }, { sheetId: 2 }],
  })
  expect(() => parseKnowledgeXlsxDocument(input, { ...xlsxLimits, maxSheets: 1 })).toThrow(
    'LIMIT_EXCEEDED',
  )
})

it('filters hidden columns beyond the preflight display-example cap', () => {
  const columns = Array.from(
    { length: 1029 },
    (_, index) => `<col min="${index * 2 + 1}" max="${index * 2 + 1}" hidden="1"/>`,
  ).join('')
  const input = selectedXlsx(
    workbookParts(
      `<cols>${columns}</cols><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>PUBLIC</t></is></c><c r="BZU1" t="inlineStr"><is><t>PRIVATE</t></is></c></row></sheetData>`,
    ),
  )
  const document = parseKnowledgeXlsxDocument(input, xlsxLimits)
  expect(document.units[0]?.cells.map((cell) => cell.a1)).toEqual(['B1'])
  expect(document.text).not.toContain('PRIVATE')
})
