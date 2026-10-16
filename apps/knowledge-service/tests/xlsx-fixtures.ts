import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { freezeKnowledgeXlsxSelection, inspectKnowledgeXlsxWorkbook } from '../src/parsing'

const encode = (value: string) => new TextEncoder().encode(value)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function xlsxZip(parts: Record<string, string>) {
  const chunks: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const [name, source] of Object.entries(parts)) {
    const filename = encode(name)
    const bytes = encode(source)
    const payload = deflateRawSync(bytes)
    const local = Buffer.alloc(30 + filename.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(bytes), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(filename.length, 26)
    local.set(filename, 30)
    const central = Buffer.alloc(46 + filename.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(bytes), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(offset, 42)
    central.set(filename, 46)
    chunks.push(local, payload)
    directory.push(central)
    offset += local.length + payload.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(directory.length, 8)
  end.writeUInt16LE(directory.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  const bytes = new Uint8Array(Buffer.concat([...chunks, central, end]))
  return { bytes, sourceHash: hash(bytes) }
}

export const xlsxLimits = {
  maxBytes: 1024 * 1024,
  maxXmlBytes: 1024 * 1024,
  maxSheets: 5,
  maxRowsPerSheet: 5000,
  maxColumnsPerSheet: 100,
  maxCells: 50000,
  maxCodePoints: 1024 * 1024,
}

export function workbookParts(sheetData: string, extras: Record<string, string> = {}) {
  return {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml':
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets><sheet sheetId="1" name="明细" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet>${sheetData}</worksheet>`,
    ...extras,
  }
}

export function selectedXlsx(parts: Record<string, string>, selection?: unknown) {
  const source = xlsxZip(parts)
  const inspection = inspectKnowledgeXlsxWorkbook(source, {
    maxBytes: xlsxLimits.maxBytes,
    maxXmlBytes: xlsxLimits.maxXmlBytes,
    maxSheets: 512,
  })
  const frozen = freezeKnowledgeXlsxSelection(
    inspection,
    {
      sourceHash: source.sourceHash,
      selection: selection ?? { includeHiddenContent: false, sheets: [{ sheetId: 1 }] },
    },
    { maxSelectedSheets: 5, maxSelectedCells: 2000000 },
  )
  return { ...source, ...frozen }
}
