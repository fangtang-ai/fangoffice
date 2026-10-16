import { expect, it } from 'vitest'
import { parseKnowledgeXlsxDocument } from '../src/parsing'
import { selectedXlsx, workbookParts, xlsxLimits } from './xlsx-fixtures'

const styles =
  '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="[Red]0.000 mystery"/><numFmt numFmtId="165" formatCode="00000"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="10"/><xf numFmtId="14"/><xf numFmtId="49"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="2"/><xf numFmtId="4"/></cellXfs></styleSheet>'

function parseCells(cells: string, extras: Record<string, string> = {}) {
  return parseKnowledgeXlsxDocument(
    selectedXlsx(
      workbookParts(`<sheetData><row r="1">${cells}</row></sheetData>`, {
        'xl/styles.xml': styles,
        ...extras,
      }),
    ),
    xlsxLimits,
  )
}

it('reads shared rich strings, booleans and exact large numbers without coercion', () => {
  const document = parseCells(
    '<c r="A1" t="s"><v>0</v></c><c r="B1" t="b"><v>0</v></c><c r="C1"><v>9007199254740993</v></c><c r="D1"/>',
    {
      'xl/sharedStrings.xml':
        '<sst><si><r><t>00</t></r><r><t xml:space="preserve">123 😀 &amp; &lt;script&gt;</t></r><rPh><t>not cell text</t></rPh></si></sst>',
    },
  )
  const cells = document.units[0]!.cells
  expect(cells[0]).toMatchObject({
    type: 'text',
    raw: '0',
    value: '00123 😀 & <script>',
    display: '00123 😀 & <script>',
  })
  expect(cells[1]).toMatchObject({ type: 'boolean', raw: '0', value: 'false', display: 'FALSE' })
  expect(cells[2]).toMatchObject({
    type: 'number',
    raw: '9007199254740993',
    value: '9007199254740993',
  })
  expect(cells[3]).toMatchObject({ type: 'blank', raw: null, value: null, display: null })
  expect(document.preview).toContain('&lt;script&gt;')
  expect(document.text).not.toContain('not cell text')
})

it('formats simple percentages, decimal numbers and numeric leading zeroes using exact decimal arithmetic', () => {
  const cells = parseCells(
    '<c r="A1" s="2"><v>0.125</v></c><c r="B1" s="7"><v>9007199254740993.125</v></c><c r="C1" s="6"><v>42</v></c><c r="D1" s="8"><v>-1234.565</v></c>',
  ).units[0]!.cells
  expect(cells.map((cell) => cell.display)).toEqual([
    '12.50%',
    '9007199254740993.13',
    '00042',
    '-1,234.57',
  ])
  expect(cells[0]?.raw).toBe('0.125')
  expect(cells[0]?.numberFormat).toBe('0.00%')
})

it('distinguishes the 1900 and 1904 date systems without silently accepting the fictitious leap day', () => {
  const standard = parseCells('<c r="A1" s="3"><v>61</v></c><c r="B1" s="3"><v>60</v></c>')
  expect(standard.units[0]?.cells[0]).toMatchObject({
    type: 'date',
    raw: '61',
    display: '1900-03-01',
  })
  expect(standard.units[0]?.cells[1]).toMatchObject({
    type: 'date',
    raw: '60',
    display: null,
    known: false,
  })
  expect(standard.coverage.status).toBe('partial')
  const parts = workbookParts(
    '<sheetData><row r="1"><c r="A1" s="3"><v>0</v></c></row></sheetData>',
    { 'xl/styles.xml': styles },
  )
  parts['xl/workbook.xml'] = parts['xl/workbook.xml'].replace(
    '<workbookPr/>',
    '<workbookPr date1904="1"/>',
  )
  expect(
    parseKnowledgeXlsxDocument(selectedXlsx(parts), xlsxLimits).units[0]?.cells[0]?.display,
  ).toBe('1904-01-01')
})

it('keeps formula text and stored caches but never treats them as fresh recalculation', () => {
  const document = parseCells('<c r="A1"><f>SUM(B1:B2)</f><v>2.50</v></c><c r="B1"><f>1+1</f></c>')
  expect(document.units[0]?.cells[0]).toMatchObject({
    raw: '2.50',
    formula: { text: 'SUM(B1:B2)', type: 'normal', cache: 'present', freshness: 'unknown' },
  })
  expect(document.units[0]?.cells[1]).toMatchObject({
    raw: null,
    display: null,
    known: false,
    formula: { text: '1+1', cache: 'missing', freshness: 'unknown' },
  })
  expect(document.coverage).toMatchObject({
    status: 'partial',
    expectedUnits: 2,
    completedUnits: 1,
    missingUnits: 1,
  })
  expect(document.coverage.warnings).toEqual(
    expect.arrayContaining([
      { code: 'FORMULA_CACHE_STALE', unitOrdinal: null },
      { code: 'FORMULA_CACHE_MISSING', unitOrdinal: null },
    ]),
  )
})

it('preserves unsupported custom formats as raw values instead of inventing a display or currency', () => {
  const document = parseCells('<c r="A1" s="5"><v>123.45</v></c>')
  expect(document.units[0]?.cells[0]).toMatchObject({
    raw: '123.45',
    value: '123.45',
    display: null,
    displayKind: 'unsupported',
    numberFormat: '[Red]0.000 mystery',
  })
  expect(document.coverage.warnings).toContainEqual({
    code: 'UNSUPPORTED_NUMBER_FORMAT',
    unitOrdinal: null,
  })
})

it('does not turn a formula with no stored result into an empty string or zero', () => {
  const document = parseCells('<c r="A1"><f>42/0</f></c>')
  expect(document.coverage).toMatchObject({ status: 'failed', completedUnits: 0, missingUnits: 1 })
  expect(document.units[0]?.cells[0]?.display).toBeNull()
  expect(document.text).toContain('[unknown]')
})

it('respects an inherited number format when a cell explicitly disables its local format', () => {
  const inherited =
    '<styleSheet><cellStyleXfs><xf numFmtId="10"/></cellStyleXfs><cellXfs><xf numFmtId="0" xfId="0" applyNumberFormat="0"/></cellXfs></styleSheet>'
  const document = parseCells('<c r="A1"><v>0.125</v></c>', { 'xl/styles.xml': inherited })
  expect(document.units[0]?.cells[0]?.display).toBe('12.50%')
})

it('applies explicit cell styles before custom row defaults and column defaults', () => {
  const stylePart =
    '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="14"/></cellXfs></styleSheet>'
  const parts = workbookParts(
    '<cols><col min="1" max="1" style="1"/></cols><sheetData><row r="1"><c r="A1"><v>0.125</v></c></row><row r="2" s="0" customFormat="1"><c r="A2"><v>0.125</v></c></row><row r="3" s="2" customFormat="1"><c r="A3"><v>61</v></c><c r="B3" s="1"><v>0.125</v></c></row><row r="4" s="2" customFormat="0"><c r="A4"><v>0.125</v></c></row></sheetData>',
    { 'xl/styles.xml': stylePart },
  )
  const cells = parseKnowledgeXlsxDocument(selectedXlsx(parts), xlsxLimits).units.flatMap(
    (row) => row.cells,
  )
  expect(cells.map((cell) => cell.display)).toEqual([
    '12.50%',
    '0.125',
    '1900-03-01',
    '12.50%',
    '12.50%',
  ])
})
