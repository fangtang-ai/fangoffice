import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { expect, it } from 'vitest'
import {
  KnowledgeTextError,
  freezeKnowledgeXlsxSelection,
  inspectKnowledgeXlsxWorkbook,
} from '../src/parsing'

const encoder = new TextEncoder()

export const inspectLimits = { maxBytes: 65536, maxXmlBytes: 65536, maxSheets: 8 }
const freezeLimits = { maxSelectedSheets: 4, maxSelectedCells: 10000 }

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries: { name: string; data: Uint8Array; store?: boolean }[]) {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.store ? 0 : 8
    const payload = entry.store ? entry.data : deflateRawSync(entry.data)
    const local = new Uint8Array(30 + entry.name.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, method, true)
    localView.setUint16(12, 0x21, true)
    localView.setUint32(14, crc32(entry.data), true)
    localView.setUint32(18, payload.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, entry.name.length, true)
    local.set(Buffer.from(entry.name), 30)
    chunks.push(local, payload)
    const centralEntry = new Uint8Array(46 + entry.name.length)
    const centralView = new DataView(centralEntry.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint16(12, 0x21, true)
    centralView.setUint32(16, crc32(entry.data), true)
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, entry.name.length, true)
    centralView.setUint32(42, offset, true)
    centralEntry.set(Buffer.from(entry.name), 46)
    central.push(centralEntry)
    offset += local.length + payload.length
  }
  const directory = Buffer.concat(central)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, directory.length, true)
  endView.setUint32(16, offset, true)
  const bytes = new Uint8Array(Buffer.concat([...chunks, directory, Buffer.from(end)]))
  return { bytes, hash: sha(bytes) }
}

const xml = (value: string) => encoder.encode(value)

const workbookXml = xml(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="表一" sheetId="1" r:id="rId1"/><sheet name="秘密表" sheetId="2" state="hidden" r:id="rId2"/><sheet name="深层隐藏" sheetId="3" state="veryHidden" r:id="rId3"/></sheets></workbook>`,
)

const workbookRelsXml = xml(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
)

const sheet1Xml = xml(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>表头甲</t></is></c><c r="B1"><v>1</v></c></row><row r="2" hidden="1"><c r="A2"><v>3</v></c><c r="B2"><f>A1+B1</f><v>4</v></c></row></sheetData><cols><col min="2" max="3" hidden="1" width="9"/></cols></worksheet>`,
)

const sheet2Xml = xml(
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>秘密</t></is></c></row></sheetData></worksheet>`,
)

const sheet3Xml = xml(
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
)

function buildWorkbook(extraEntries: { name: string; data: Uint8Array }[] = []) {
  return buildZip([
    { name: '[Content_Types].xml', data: xml('<Types/>') },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml },
    { name: 'xl/worksheets/sheet3.xml', data: sheet3Xml },
    ...extraEntries,
  ])
}

it('inspects sheets with visibility, dimensions, hidden rows and columns', () => {
  const { bytes, hash } = buildWorkbook()
  const report = inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)
  expect(report.revision).toBe('xlsx-ooxml-preflight-v1')
  expect(report.sourceHash).toBe(hash)
  expect(report.byteSize).toBe(bytes.byteLength)
  expect(report.dateSystem).toBe('1904')
  expect(report.unsupported).toEqual({ hasMacros: false, externalLinkCount: 0 })
  expect(report.sheets).toEqual([
    {
      sheetId: '1',
      name: '表一',
      state: 'visible',
      dimension: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 },
      used: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 },
      cellCount: 4,
      formulaCount: 1,
      hiddenRowCount: 1,
      hiddenRowRanges: [{ start: 2, end: 2 }],
      hiddenColumnCount: 2,
      hiddenColumnRanges: [{ start: 2, end: 3 }],
    },
    {
      sheetId: '2',
      name: '秘密表',
      state: 'hidden',
      dimension: null,
      used: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
      cellCount: 1,
      formulaCount: 0,
      hiddenRowCount: 0,
      hiddenRowRanges: [],
      hiddenColumnCount: 0,
      hiddenColumnRanges: [],
    },
    {
      sheetId: '3',
      name: '深层隐藏',
      state: 'veryHidden',
      dimension: null,
      used: null,
      cellCount: 0,
      formulaCount: 0,
      hiddenRowCount: 0,
      hiddenRowRanges: [],
      hiddenColumnCount: 0,
      hiddenColumnRanges: [],
    },
  ])
})

it('freezes a default visible-sheet selection with a canonical snapshot hash', () => {
  const { bytes, hash } = buildWorkbook()
  const report = inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)
  const frozen = freezeKnowledgeXlsxSelection(
    report,
    { sourceHash: hash, selection: { includeHiddenContent: false, sheets: [{ sheetId: 1 }] } },
    freezeLimits,
  )
  expect(frozen.snapshot).toEqual({
    revision: 'xlsx-ooxml-preflight-v1',
    sourceHash: hash,
    dateSystem: '1904',
    includeHiddenContent: false,
    sheets: [
      {
        sheetId: '1',
        name: '表一',
        state: 'visible',
        range: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 },
      },
    ],
  })
  expect(frozen.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
  const again = freezeKnowledgeXlsxSelection(
    report,
    { sourceHash: hash, selection: { includeHiddenContent: false, sheets: [{ sheetId: 1 }] } },
    freezeLimits,
  )
  expect(again.snapshotHash).toBe(frozen.snapshotHash)
})

it('rejects hidden sheets without explicit hidden-content confirmation', () => {
  const { bytes, hash } = buildWorkbook()
  const report = inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)
  expect(() =>
    freezeKnowledgeXlsxSelection(
      report,
      { sourceHash: hash, selection: { includeHiddenContent: false, sheets: [{ sheetId: 2 }] } },
      freezeLimits,
    ),
  ).toThrow(KnowledgeTextError)
  const allowed = freezeKnowledgeXlsxSelection(
    report,
    { sourceHash: hash, selection: { includeHiddenContent: true, sheets: [{ sheetId: 2 }] } },
    freezeLimits,
  )
  expect(allowed.snapshot.sheets[0]).toEqual({
    sheetId: '2',
    name: '秘密表',
    state: 'hidden',
    range: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
  })
})

it('freezes explicit ranges instead of the used range', () => {
  const { bytes, hash } = buildWorkbook()
  const report = inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)
  const frozen = freezeKnowledgeXlsxSelection(
    report,
    {
      sourceHash: hash,
      selection: {
        includeHiddenContent: false,
        sheets: [{ sheetId: 1, range: { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 } }],
      },
    },
    freezeLimits,
  )
  expect(frozen.snapshot.sheets[0]!.range).toEqual({
    startRow: 1,
    endRow: 1,
    startColumn: 1,
    endColumn: 1,
  })
})

it('rejects invalid selections instead of guessing', () => {
  const { bytes, hash } = buildWorkbook()
  const report = inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)
  const cases = [
    {
      sourceHash: sha(encoder.encode('other')),
      selection: { includeHiddenContent: false, sheets: [] },
    },
    { sourceHash: hash, selection: { includeHiddenContent: false, sheets: [{ sheetId: 9 }] } },
    {
      sourceHash: hash,
      selection: { includeHiddenContent: false, sheets: [{ sheetId: 1 }, { sheetId: 1 }] },
    },
    {
      sourceHash: hash,
      selection: {
        includeHiddenContent: false,
        sheets: [{ sheetId: 1, range: { startRow: 0, endRow: 1, startColumn: 1, endColumn: 1 } }],
      },
    },
    {
      sourceHash: hash,
      selection: {
        includeHiddenContent: false,
        sheets: [{ sheetId: 1, range: { startRow: 1, endRow: 1, startColumn: 2, endColumn: 1 } }],
      },
    },
    {
      sourceHash: hash,
      selection: {
        includeHiddenContent: false,
        sheets: [
          { sheetId: 1, range: { startRow: 1, endRow: 1048577, startColumn: 1, endColumn: 1 } },
        ],
      },
    },
    {
      sourceHash: hash,
      selection: {
        includeHiddenContent: false,
        sheets: [
          { sheetId: 1, range: { startRow: 1, endRow: 1, startColumn: 1, endColumn: 16385 } },
        ],
      },
    },
  ]
  for (const request of cases)
    expect(() => freezeKnowledgeXlsxSelection(report, request, freezeLimits)).toThrow(
      KnowledgeTextError,
    )
})

it('rejects selections beyond the cell budget instead of truncating', () => {
  const { bytes, hash } = buildWorkbook()
  const report = inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)
  expect(() =>
    freezeKnowledgeXlsxSelection(
      report,
      {
        sourceHash: hash,
        selection: {
          includeHiddenContent: false,
          sheets: [
            {
              sheetId: 1,
              range: { startRow: 1, endRow: 1048576, startColumn: 1, endColumn: 16384 },
            },
          ],
        },
      },
      freezeLimits,
    ),
  ).toThrow(KnowledgeTextError)
  expect(() =>
    freezeKnowledgeXlsxSelection(
      report,
      {
        sourceHash: hash,
        selection: {
          includeHiddenContent: false,
          sheets: [{ sheetId: 1 }, { sheetId: 2 }, { sheetId: 3 }, { sheetId: 4 }],
        },
      },
      { maxSelectedSheets: 3, maxSelectedCells: 10000 },
    ),
  ).toThrow(KnowledgeTextError)
})

it('reports macros and external links as unsupported while still allowing confirmed selections', () => {
  const { bytes, hash } = buildWorkbook([
    { name: 'xl/vbaProject.bin', data: encoder.encode('vba') },
    { name: 'xl/externalLinks/externalLink1.xml', data: xml('<externalLink/>') },
    { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: xml('<Relationships/>') },
  ])
  const report = inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)
  expect(report.unsupported).toEqual({ hasMacros: true, externalLinkCount: 1 })
  const frozen = freezeKnowledgeXlsxSelection(
    report,
    { sourceHash: hash, selection: { includeHiddenContent: false, sheets: [{ sheetId: 1 }] } },
    freezeLimits,
  )
  expect(frozen.snapshot.sheets).toHaveLength(1)
})

it('rejects encrypted packages before inspecting content', () => {
  const { bytes, hash } = buildZip([
    { name: '[Content_Types].xml', data: xml('<Types/>') },
    { name: 'EncryptionInfo', data: xml('<encryption/>') },
    { name: 'EncryptedPackage', data: new Uint8Array(64) },
  ])
  expect(() => inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, inspectLimits)).toThrow(
    KnowledgeTextError,
  )
})

it('rejects broken workbooks instead of pretending structure', () => {
  const missingWorkbook = buildZip([
    { name: '[Content_Types].xml', data: xml('<Types/>') },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
  ])
  expect(() =>
    inspectKnowledgeXlsxWorkbook(
      { bytes: missingWorkbook.bytes, sourceHash: missingWorkbook.hash },
      inspectLimits,
    ),
  ).toThrow(KnowledgeTextError)

  const danglingRel = buildZip([
    { name: '[Content_Types].xml', data: xml('<Types/>') },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml },
  ])
  expect(() =>
    inspectKnowledgeXlsxWorkbook(
      { bytes: danglingRel.bytes, sourceHash: danglingRel.hash },
      inspectLimits,
    ),
  ).toThrow(KnowledgeTextError)

  const noSheets = buildZip([
    { name: '[Content_Types].xml', data: xml('<Types/>') },
    {
      name: 'xl/workbook.xml',
      data: xml(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
      ),
    },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
  ])
  expect(() =>
    inspectKnowledgeXlsxWorkbook(
      { bytes: noSheets.bytes, sourceHash: noSheets.hash },
      inspectLimits,
    ),
  ).toThrow(KnowledgeTextError)

  const cellWithoutRef = buildZip([
    { name: '[Content_Types].xml', data: xml('<Types/>') },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xml(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c><v>1</v></c></row></sheetData></worksheet>',
      ),
    },
  ])
  expect(() =>
    inspectKnowledgeXlsxWorkbook(
      { bytes: cellWithoutRef.bytes, sourceHash: cellWithoutRef.hash },
      inspectLimits,
    ),
  ).toThrow(KnowledgeTextError)
})

it('enforces byte, xml and sheet-count limits without silent truncation', () => {
  const { bytes, hash } = buildWorkbook()
  expect(() =>
    inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, { ...inspectLimits, maxBytes: 16 }),
  ).toThrow(KnowledgeTextError)
  expect(() =>
    inspectKnowledgeXlsxWorkbook(
      { bytes, sourceHash: hash },
      { ...inspectLimits, maxXmlBytes: 32 },
    ),
  ).toThrow(KnowledgeTextError)
  expect(() =>
    inspectKnowledgeXlsxWorkbook({ bytes, sourceHash: hash }, { ...inspectLimits, maxSheets: 2 }),
  ).toThrow(KnowledgeTextError)
})
