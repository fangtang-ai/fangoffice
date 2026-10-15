import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { KnowledgeTextError, parseKnowledgeDocxDocument } from '../src/parsing'

const encoder = new TextEncoder()

export const docxLimits = { maxBytes: 65536, maxXmlBytes: 65536, maxBlocks: 100 }

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
  const dataStarts: Record<string, number> = {}
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
    dataStarts[entry.name] = offset + 30 + entry.name.length
    const centralEntry = new Uint8Array(46 + entry.name.length)
    const centralView = new DataView(centralEntry.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint16(14, 0x21, true)
    centralView.setUint32(16, crc32(entry.data), true)
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, entry.name.length, true)
    centralView.setUint32(42, offset, true)
    centralEntry.set(Buffer.from(entry.name), 46)
    central.push(centralEntry)
    offset += local.length + payload.length
  }
  const centralStart = offset
  const centralLength = central.reduce((sum, entry) => sum + entry.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralLength, true)
  eocdView.setUint32(16, centralStart, true)
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralLength + eocd.length
  const container = new Uint8Array(total)
  let position = 0
  for (const chunk of [...chunks, ...central, eocd]) {
    container.set(chunk, position)
    position += chunk.length
  }
  return { bytes: container, dataStarts }
}

function buildDocx(
  documentXml: string,
  extra: { name: string; data: string }[] = [],
): { bytes: Uint8Array; sourceHash: string; dataStarts: Record<string, number> } {
  const { bytes, dataStarts } = buildZip([
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
    },
    { name: 'word/document.xml', data: encoder.encode(documentXml) },
    ...extra.map((entry) => ({ name: entry.name, data: encoder.encode(entry.data) })),
  ])
  return { bytes, sourceHash: sha(bytes), dataStarts }
}

const docxInput = (documentXml: string, extra?: { name: string; data: string }[]) => {
  const { bytes, sourceHash } = buildDocx(documentXml, extra)
  return { bytes, sourceHash }
}

const happyXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>章节甲</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>正文&amp;段&lt;落</w:t></w:r></w:p>' +
  '<w:tbl>' +
  '<w:tr><w:tc><w:p><w:r><w:t>甲1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙1</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>甲2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙2</w:t></w:r></w:p></w:tc></w:tr>' +
  '</w:tbl>' +
  '<w:p><w:r><w:t>表格后段落</w:t></w:r></w:p>' +
  '<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>小节乙</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>尾段</w:t></w:r></w:p>' +
  '</w:body></w:document>'

function failure(parse: () => unknown) {
  try {
    parse()
  } catch (error) {
    if (!(error instanceof KnowledgeTextError)) throw error
    return error.reason
  }
  throw new Error('expected rejection')
}

it('produces deterministic complete DOCX DocIR with heading path, reading order and table cells', () => {
  const input = docxInput(happyXml)
  const document = parseKnowledgeDocxDocument(input, docxLimits)
  expect(document).toMatchObject({
    schemaVersion: 1,
    format: 'docx',
    parserRevision: 'docx-ooxml-blocks-v1',
    textCodePointLength: 35,
    coverage: {
      scope: 'document',
      unit: 'block',
      status: 'complete',
      expectedUnits: 9,
      completedUnits: 9,
      missingUnits: 0,
      excludedUnits: 0,
      warnings: [],
    },
  })
  expect(document.sourceBytes).toEqual({ unit: 'bytes', value: String(input.bytes.byteLength) })
  expect(document.text).toEqual('章节甲\n正文&段<落\n甲1\n乙1\n甲2\n乙2\n表格后段落\n小节乙\n尾段')
  expect(
    document.units.map((unit) => ({
      kind: unit.kind,
      text: unit.text,
      path: unit.locator.headingPath,
      blockIndex: unit.locator.blockIndex,
      table: unit.locator.table,
      span: unit.documentSpan,
    })),
  ).toEqual([
    {
      kind: 'heading',
      text: '章节甲',
      path: [],
      blockIndex: 0,
      table: null,
      span: { unit: 'unicode_code_point', origin: 0, start: 0, end: 3 },
    },
    {
      kind: 'paragraph',
      text: '正文&段<落',
      path: ['章节甲'],
      blockIndex: 1,
      table: null,
      span: { unit: 'unicode_code_point', origin: 0, start: 4, end: 10 },
    },
    {
      kind: 'table_cell',
      text: '甲1',
      path: ['章节甲'],
      blockIndex: 2,
      table: { unit: 'table_cell', origin: 1, tableIndex: 0, row: 1, column: 1 },
      span: { unit: 'unicode_code_point', origin: 0, start: 11, end: 13 },
    },
    {
      kind: 'table_cell',
      text: '乙1',
      path: ['章节甲'],
      blockIndex: 3,
      table: { unit: 'table_cell', origin: 1, tableIndex: 0, row: 1, column: 2 },
      span: { unit: 'unicode_code_point', origin: 0, start: 14, end: 16 },
    },
    {
      kind: 'table_cell',
      text: '甲2',
      path: ['章节甲'],
      blockIndex: 4,
      table: { unit: 'table_cell', origin: 1, tableIndex: 0, row: 2, column: 1 },
      span: { unit: 'unicode_code_point', origin: 0, start: 17, end: 19 },
    },
    {
      kind: 'table_cell',
      text: '乙2',
      path: ['章节甲'],
      blockIndex: 5,
      table: { unit: 'table_cell', origin: 1, tableIndex: 0, row: 2, column: 2 },
      span: { unit: 'unicode_code_point', origin: 0, start: 20, end: 22 },
    },
    {
      kind: 'paragraph',
      text: '表格后段落',
      path: ['章节甲'],
      blockIndex: 6,
      table: null,
      span: { unit: 'unicode_code_point', origin: 0, start: 23, end: 28 },
    },
    {
      kind: 'heading',
      text: '小节乙',
      path: ['章节甲'],
      blockIndex: 7,
      table: null,
      span: { unit: 'unicode_code_point', origin: 0, start: 29, end: 32 },
    },
    {
      kind: 'paragraph',
      text: '尾段',
      path: ['章节甲', '小节乙'],
      blockIndex: 8,
      table: null,
      span: { unit: 'unicode_code_point', origin: 0, start: 33, end: 35 },
    },
  ])
  // DOCX has no fixed page numbers; the locator must never invent one.
  expect(Object.keys(document.units[0]!.locator).sort()).toEqual([
    'blockIndex',
    'format',
    'headingPath',
    'schemaVersion',
    'sourceHash',
    'span',
    'table',
    'textHash',
  ])
  expect(document.preview).not.toContain('<')
  expect(document.preview).toContain('&amp;')
  expect(document.units[1]!.text).toContain('&')
})

it('marks corrupt containers and integrity failures instead of pretending success', () => {
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(
        { bytes: Uint8Array.from([1, 2, 3]), sourceHash: sha(Uint8Array.from([1, 2, 3])) },
        docxLimits,
      ),
    ),
  ).toBe('CORRUPT_CONTAINER')
  const noDocument = buildZip([
    { name: '[Content_Types].xml', data: encoder.encode('<Types xmlns="urn:x"/>') },
  ])
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(
        { bytes: noDocument.bytes, sourceHash: sha(noDocument.bytes) },
        docxLimits,
      ),
    ),
  ).toBe('CORRUPT_CONTAINER')
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(docxInput('<?xml version="1.0"?><w:document/>'), docxLimits),
    ),
  ).toBe('CORRUPT_CONTAINER')
  const tampered = buildDocx(happyXml)
  tampered.bytes[tampered.dataStarts['word/document.xml']!] += 1
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(
        { bytes: tampered.bytes, sourceHash: sha(tampered.bytes) },
        docxLimits,
      ),
    ),
  ).toBe('CORRUPT_CONTAINER')
  const stored = buildZip([
    { name: '[Content_Types].xml', data: encoder.encode('<Types xmlns="urn:x"/>'), store: true },
    { name: 'word/document.xml', data: encoder.encode(happyXml), store: true },
  ])
  stored.bytes[stored.dataStarts['word/document.xml']!] = 0x00
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(
        { bytes: stored.bytes, sourceHash: sha(stored.bytes) },
        docxLimits,
      ),
    ),
  ).toBe('CORRUPT_CONTAINER')
})

it('rejects containers and inflate budgets over the policy limits', () => {
  const input = docxInput(happyXml)
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(input, { ...docxLimits, maxBytes: input.bytes.byteLength - 1 }),
    ),
  ).toBe('LIMIT_EXCEEDED')
  expect(failure(() => parseKnowledgeDocxDocument(input, { ...docxLimits, maxXmlBytes: 8 }))).toBe(
    'LIMIT_EXCEEDED',
  )
})

it('truncates at maxBlocks with explicit MISSING_UNITS coverage instead of silent completion', () => {
  const document = parseKnowledgeDocxDocument(docxInput(happyXml), { ...docxLimits, maxBlocks: 3 })
  expect(document.units).toHaveLength(3)
  expect(document.coverage).toMatchObject({
    scope: 'document',
    unit: 'block',
    status: 'partial',
    expectedUnits: 9,
    completedUnits: 3,
    missingUnits: 6,
    excludedUnits: 0,
    warnings: [{ code: 'MISSING_UNITS', unitOrdinal: null }],
  })
})

it('flattens nested table text into the parent cell and marks TABLE_INCOMPLETE', () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>外段</w:t></w:r></w:p>' +
    '<w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>上</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>内</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc>' +
    '<w:tc><w:p><w:r><w:t>右</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>' +
    '</w:body></w:document>'
  const document = parseKnowledgeDocxDocument(docxInput(xml), docxLimits)
  expect(document.units.map((unit) => ({ kind: unit.kind, text: unit.text }))).toEqual([
    { kind: 'paragraph', text: '外段' },
    { kind: 'table_cell', text: '上\n内' },
    { kind: 'table_cell', text: '右' },
  ])
  expect(document.coverage).toMatchObject({
    status: 'partial',
    expectedUnits: 3,
    completedUnits: 3,
    missingUnits: 0,
    warnings: [{ code: 'TABLE_INCOMPLETE', unitOrdinal: 1 }],
  })
})

it('keeps tab and line-break structure and reports unsupported footnote content', () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>注段</w:t></w:r><w:footnoteReference w:id="2"/></w:p>' +
    '</w:body></w:document>'
  const document = parseKnowledgeDocxDocument(docxInput(xml), docxLimits)
  expect(document.units.map((unit) => unit.text)).toEqual(['甲\t乙\n丙', '注段'])
  expect(document.coverage).toMatchObject({
    status: 'partial',
    expectedUnits: 2,
    completedUnits: 2,
    missingUnits: 0,
    warnings: [{ code: 'UNSUPPORTED_CONTENT', unitOrdinal: 1 }],
  })
})

it('rejects containers without body content and non-document xml roots', () => {
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(
        docxInput(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:pPr/></w:p></w:body></w:document>',
        ),
        docxLimits,
      ),
    ),
  ).toBe('EMPTY_CONTENT')
  expect(
    failure(() =>
      parseKnowledgeDocxDocument(
        docxInput('<?xml version="1.0"?><w:spreadsheet xmlns:w="urn:x"><w:sheet/></w:spreadsheet>'),
        docxLimits,
      ),
    ),
  ).toBe('CORRUPT_CONTAINER')
})
