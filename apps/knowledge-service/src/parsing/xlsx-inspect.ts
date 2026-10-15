import { rejectText } from './errors'
import { xlsxRequest, xlsxSelectionRequest } from './request'
import { textHash } from './text-unit'
import { readZipEntry, zipEntries } from './zip'

export const xlsxInspectRevision = 'xlsx-ooxml-preflight-v1'

// shortcut: entity/attr/tag helpers duplicate docx.ts locals; extracting a shared xml.ts waits for F7 sheet parsing.
const entityPattern = /&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g

function decodeEntities(value: string) {
  return value.replace(entityPattern, (match) => {
    if (match === '&lt;') return '<'
    if (match === '&gt;') return '>'
    if (match === '&amp;') return '&'
    if (match === '&quot;') return '"'
    if (match === '&apos;') return "'"
    const numeric = match.slice(1, -1)
    const point = numeric.startsWith('#x')
      ? Number.parseInt(numeric.slice(2), 16)
      : Number.parseInt(numeric.slice(1), 10)
    if (!Number.isSafeInteger(point) || point < 1 || point > 0x10ffff)
      rejectText('CORRUPT_CONTAINER')
    return String.fromCodePoint(point)
  })
}

function parseAttributes(fragment: string) {
  const attrs: Record<string, string> = {}
  const pattern = /([A-Za-z0-9_.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(fragment)))
    attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? '')
  return attrs
}

type TagVisitor = (
  prefix: string,
  local: string,
  attrs: Record<string, string>,
  selfClosing: boolean,
) => void

// Tag-level scan without a document stack: preflight only reads flat row/col/cell markers.
// Closing tags carry no information here, so they are skipped rather than balanced.
function scanXmlTags(xml: string, onTag: TagVisitor) {
  let position = 0
  const prolog = /<\?xml[^?]*\?>/.exec(xml.slice(0, 200))
  if (prolog) position = prolog[0].length
  while (position < xml.length) {
    const lessThan = xml.indexOf('<', position)
    if (lessThan < 0) rejectText('CORRUPT_CONTAINER')
    if (xml.startsWith('<!--', lessThan)) {
      const end = xml.indexOf('-->', lessThan + 4)
      if (end < 0) rejectText('CORRUPT_CONTAINER')
      position = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lessThan)) {
      const end = xml.indexOf(']]>', lessThan + 9)
      if (end < 0) rejectText('CORRUPT_CONTAINER')
      position = end + 3
      continue
    }
    if (xml[lessThan + 1] === '?') {
      const end = xml.indexOf('?>', lessThan + 2)
      if (end < 0) rejectText('CORRUPT_CONTAINER')
      position = end + 2
      continue
    }
    if (xml[lessThan + 1] === '!') {
      const end = xml.indexOf('>', lessThan + 2)
      if (end < 0) rejectText('CORRUPT_CONTAINER')
      position = end + 1
      continue
    }
    let quote: string | null = null
    let greaterThan = -1
    for (let index = lessThan + 1; index < xml.length; index += 1) {
      const character = xml[index]!
      if (quote) {
        if (character === quote) quote = null
      } else if (character === '"' || character === "'") quote = character
      else if (character === '>') {
        greaterThan = index
        break
      }
    }
    if (greaterThan < 0) rejectText('CORRUPT_CONTAINER')
    const fragment = xml.slice(lessThan + 1, greaterThan)
    position = greaterThan + 1
    if (fragment.startsWith('/')) continue
    const selfClosing = fragment.endsWith('/')
    const tag = selfClosing ? fragment.slice(0, -1) : fragment
    const separator = tag.search(/[\s:/]/)
    if (separator === 0) rejectText('CORRUPT_CONTAINER')
    const name = separator < 0 ? tag : tag.slice(0, separator)
    const rest = separator < 0 ? '' : tag.slice(separator)
    const colon = name.indexOf(':')
    const prefix = colon < 0 ? '' : name.slice(0, colon)
    const local = colon < 0 ? name : name.slice(colon + 1)
    if (!local) rejectText('CORRUPT_CONTAINER')
    onTag(prefix, local, parseAttributes(rest), selfClosing)
  }
}

function parseSheetRef(ref: string) {
  const match = /^([A-Z]{1,3})([0-9]+)$/.exec(ref)
  if (!match) rejectText('CORRUPT_CONTAINER')
  let column = 0
  for (const letter of match[1]!) column = column * 26 + (letter.charCodeAt(0) - 64)
  const row = Number(match[2]!)
  if (!Number.isSafeInteger(row) || row < 1 || row > 1048576 || column < 1 || column > 16384)
    rejectText('CORRUPT_CONTAINER')
  return { row, column }
}

type GridRange = { startRow: number; startColumn: number; endRow: number; endColumn: number }

function parseDimensionRef(ref: string): GridRange | null {
  const parts = ref.split(':')
  if (parts.length > 2) return null
  try {
    const first = parseSheetRef(parts[0]!)
    if (parts.length === 1)
      return {
        startRow: first.row,
        startColumn: first.column,
        endRow: first.row,
        endColumn: first.column,
      }
    const last = parseSheetRef(parts[1]!)
    if (last.row < first.row || last.column < first.column) return null
    return {
      startRow: first.row,
      startColumn: first.column,
      endRow: last.row,
      endColumn: last.column,
    }
  } catch {
    return null
  }
}

function mergeRanges(values: { start: number; end: number }[]) {
  const sorted = [...values].sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const value of sorted) {
    const last = merged[merged.length - 1]
    if (last && value.start <= last.end + 1) {
      if (value.end > last.end) last.end = value.end
      continue
    }
    merged.push({ start: value.start, end: value.end })
  }
  return merged
}

// Example ranges are display hints; exact counts live in hiddenRowCount/hiddenColumnCount.
const maxRangeExamples = 1024

type SheetSummary = {
  sheetId: string
  name: string
  state: 'visible' | 'hidden' | 'veryHidden'
  dimension: GridRange | null
  used: GridRange | null
  cellCount: number
  formulaCount: number
  hiddenRowCount: number
  hiddenRowRanges: { start: number; end: number }[]
  hiddenColumnCount: number
  hiddenColumnRanges: { start: number; end: number }[]
}

function inspectSheetXml(xmlBytes: Uint8Array): Omit<SheetSummary, 'sheetId' | 'name' | 'state'> {
  const xml = Buffer.from(xmlBytes).toString('utf-8')
  let sawRoot = false
  let dimension: GridRange | null = null
  let cellCount = 0
  let formulaCount = 0
  // Holder object: closures cannot rely on let-null narrowing, properties keep the declared type.
  const acc = {
    used: null as null | { minRow: number; minColumn: number; maxRow: number; maxColumn: number },
  }
  let lastRow = 0
  const hiddenRows: { start: number; end: number }[] = []
  const hiddenColumns: { start: number; end: number }[] = []

  scanXmlTags(xml, (_prefix, local, attrs) => {
    if (!sawRoot) {
      sawRoot = true
      if (local !== 'worksheet') rejectText('CORRUPT_CONTAINER')
    }
    if (local === 'dimension') {
      if (attrs.ref) dimension = parseDimensionRef(attrs.ref)
      return
    }
    if (local === 'row') {
      let row = lastRow + 1
      if (attrs.r !== undefined) {
        row = Number(attrs.r)
        if (!Number.isSafeInteger(row) || row < 1 || row > 1048576) rejectText('CORRUPT_CONTAINER')
      }
      lastRow = row
      if (attrs.hidden === '1' || attrs.hidden === 'true') hiddenRows.push({ start: row, end: row })
      return
    }
    if (local === 'col') {
      if (attrs.hidden !== '1' && attrs.hidden !== 'true') return
      const min = Number(attrs.min)
      const max = Number(attrs.max)
      if (
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(max) ||
        min < 1 ||
        max < min ||
        max > 16384
      )
        rejectText('CORRUPT_CONTAINER')
      hiddenColumns.push({ start: min, end: max })
      return
    }
    if (local === 'c') {
      if (attrs.r === undefined) rejectText('CORRUPT_CONTAINER')
      const { row, column } = parseSheetRef(attrs.r)
      cellCount += 1
      if (!acc.used) acc.used = { minRow: row, minColumn: column, maxRow: row, maxColumn: column }
      else {
        if (row < acc.used.minRow) acc.used.minRow = row
        if (column < acc.used.minColumn) acc.used.minColumn = column
        if (row > acc.used.maxRow) acc.used.maxRow = row
        if (column > acc.used.maxColumn) acc.used.maxColumn = column
      }
      return
    }
    if (local === 'f') formulaCount += 1
  })
  if (!sawRoot) rejectText('CORRUPT_CONTAINER')

  const mergedRows = mergeRanges(hiddenRows)
  const mergedColumns = mergeRanges(hiddenColumns)
  return {
    dimension,
    used: acc.used
      ? {
          startRow: acc.used.minRow,
          startColumn: acc.used.minColumn,
          endRow: acc.used.maxRow,
          endColumn: acc.used.maxColumn,
        }
      : null,
    cellCount,
    formulaCount,
    hiddenRowCount: hiddenRows.length,
    hiddenRowRanges: mergedRows.slice(0, maxRangeExamples),
    hiddenColumnCount: hiddenColumns.reduce((sum, range) => sum + (range.end - range.start + 1), 0),
    hiddenColumnRanges: mergedColumns.slice(0, maxRangeExamples),
  }
}

function resolvePartTarget(target: string, mode: string | undefined) {
  // Sheet targets must be internal package parts; any scheme (http:, file:) is not a worksheet.
  if (mode === 'External' || /^[a-z][a-z0-9+.-]*:/i.test(target)) rejectText('CORRUPT_CONTAINER')
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
  const stack: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (stack.length <= 1) rejectText('CORRUPT_CONTAINER')
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  const resolved = stack.join('/')
  if (!resolved.startsWith('xl/')) rejectText('CORRUPT_CONTAINER')
  return resolved
}

export function inspectKnowledgeXlsxWorkbook(value: unknown, policy: unknown) {
  const { input, limits } = xlsxRequest(value, policy)
  if (textHash(input.bytes) !== input.sourceHash) rejectText('SOURCE_MISMATCH')
  const entries = zipEntries(input.bytes)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  // Password-protected workbooks ship as OPC packages with encrypted payloads; refuse, never guess.
  if (byName.has('EncryptionInfo') || byName.has('EncryptedPackage')) rejectText('ENCRYPTED_FILE')
  const workbookEntry = byName.get('xl/workbook.xml')
  if (!workbookEntry) rejectText('CORRUPT_CONTAINER')
  const workbookXml = Buffer.from(
    readZipEntry(input.bytes, workbookEntry, limits.maxXmlBytes),
  ).toString('utf-8')

  type DeclaredSheet = {
    id: number
    name: string
    state: 'visible' | 'hidden' | 'veryHidden'
    relId: string | null
  }
  const declared: DeclaredSheet[] = []
  const seenIds = new Set<number>()
  const seenNames = new Set<string>()
  let date1904 = false
  let sawRoot = false
  scanXmlTags(workbookXml, (_prefix, local, attrs) => {
    if (!sawRoot) {
      sawRoot = true
      if (local !== 'workbook') rejectText('CORRUPT_CONTAINER')
    }
    if (local === 'workbookPr') {
      if (attrs.date1904 === '1' || attrs.date1904 === 'true') date1904 = true
      return
    }
    if (local !== 'sheet') return
    const id = Number(attrs.sheetId)
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) rejectText('CORRUPT_CONTAINER')
    const name = attrs.name ?? ''
    if (!name || name.length > 31 || seenNames.has(name)) rejectText('CORRUPT_CONTAINER')
    if (seenIds.has(id)) rejectText('CORRUPT_CONTAINER')
    const state = attrs.state ?? 'visible'
    if (state !== 'visible' && state !== 'hidden' && state !== 'veryHidden')
      rejectText('CORRUPT_CONTAINER')
    seenIds.add(id)
    seenNames.add(name)
    declared.push({ id, name, state, relId: attrs['r:id'] ?? null })
    if (declared.length > limits.maxSheets) rejectText('LIMIT_EXCEEDED')
  })
  if (!sawRoot) rejectText('CORRUPT_CONTAINER')
  if (declared.length === 0) rejectText('EMPTY_CONTENT')

  const relsEntry = byName.get('xl/_rels/workbook.xml.rels')
  if (!relsEntry) rejectText('CORRUPT_CONTAINER')
  const relsXml = Buffer.from(readZipEntry(input.bytes, relsEntry, limits.maxXmlBytes)).toString(
    'utf-8',
  )
  const targets = new Map<string, string>()
  scanXmlTags(relsXml, (_prefix, local, attrs) => {
    if (local !== 'Relationship') return
    const id = attrs.Id
    if (!id || attrs.Target === undefined || targets.has(id)) rejectText('CORRUPT_CONTAINER')
    targets.set(id, resolvePartTarget(attrs.Target, attrs.TargetMode))
  })

  const sheets: SheetSummary[] = []
  for (const sheet of declared) {
    if (sheet.relId === null) rejectText('CORRUPT_CONTAINER')
    const target = targets.get(sheet.relId)
    if (!target) rejectText('CORRUPT_CONTAINER')
    const entry = byName.get(target)
    if (!entry) rejectText('CORRUPT_CONTAINER')
    const inspected = inspectSheetXml(readZipEntry(input.bytes, entry, limits.maxXmlBytes))
    sheets.push({ sheetId: String(sheet.id), name: sheet.name, state: sheet.state, ...inspected })
  }

  return {
    revision: xlsxInspectRevision,
    sourceHash: input.sourceHash,
    byteSize: input.bytes.byteLength,
    dateSystem: date1904 ? ('1904' as const) : ('1900' as const),
    sheets,
    unsupported: {
      hasMacros: byName.has('xl/vbaProject.bin'),
      externalLinkCount: entries.filter((entry) =>
        /^xl\/externalLinks\/[^/]+\.xml$/.test(entry.name),
      ).length,
    },
  }
}

export type KnowledgeXlsxInspection = ReturnType<typeof inspectKnowledgeXlsxWorkbook>

export function freezeKnowledgeXlsxSelection(
  inspection: KnowledgeXlsxInspection,
  value: unknown,
  policy: unknown,
) {
  const { limits } = xlsxSelectionRequest(policy)
  // Macros and external links are reported by the preflight (they are never executed, only read);
  // whether to proceed is the user's confirmed choice, frozen into the snapshot.
  if (
    typeof value !== 'object' ||
    !value ||
    Object.keys(value).length !== 2 ||
    !('sourceHash' in value) ||
    !('selection' in value) ||
    typeof (value as { sourceHash: unknown }).sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test((value as { sourceHash: string }).sourceHash)
  )
    rejectText('INVALID_REQUEST')
  if ((value as { sourceHash: string }).sourceHash !== inspection.sourceHash)
    rejectText('SOURCE_MISMATCH')
  const selection = (value as { selection: unknown }).selection
  if (
    typeof selection !== 'object' ||
    !selection ||
    Object.keys(selection).length !== 2 ||
    !('includeHiddenContent' in selection) ||
    !('sheets' in selection) ||
    typeof (selection as { includeHiddenContent: unknown }).includeHiddenContent !== 'boolean' ||
    !Array.isArray((selection as { sheets: unknown }).sheets)
  )
    rejectText('INVALID_REQUEST')
  const includeHiddenContent = (selection as { includeHiddenContent: boolean }).includeHiddenContent
  const requested = (selection as { sheets: Record<string, unknown>[] }).sheets
  if (requested.length > limits.maxSelectedSheets) rejectText('LIMIT_EXCEEDED')

  const byId = new Map(inspection.sheets.map((sheet) => [Number(sheet.sheetId), sheet]))
  const seen = new Set<number>()
  let totalCells = 0
  const sheets = requested.map((entry) => {
    if (
      typeof entry !== 'object' ||
      !entry ||
      !('sheetId' in entry) ||
      !('range' in entry ? Object.keys(entry).length === 2 : Object.keys(entry).length === 1)
    )
      rejectText('INVALID_REQUEST')
    const id = (entry as { sheetId: unknown }).sheetId
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > 2147483647)
      rejectText('INVALID_REQUEST')
    if (seen.has(id)) rejectText('INVALID_REQUEST')
    seen.add(id)
    const sheet = byId.get(id)
    if (!sheet) rejectText('INVALID_REQUEST')
    // Hidden sheets (and hidden rows/columns inside visible sheets) are indexed only with explicit confirmation.
    if (sheet.state !== 'visible' && !includeHiddenContent) rejectText('INVALID_REQUEST')
    const rawRange = (entry as { range?: unknown }).range
    let range: GridRange | null = null
    if (rawRange !== undefined) {
      if (
        typeof rawRange !== 'object' ||
        !rawRange ||
        Object.keys(rawRange).length !== 4 ||
        !('startRow' in rawRange) ||
        !('endRow' in rawRange) ||
        !('startColumn' in rawRange) ||
        !('endColumn' in rawRange)
      )
        rejectText('INVALID_REQUEST')
      const bounds = rawRange as Record<string, unknown>
      const bounded = (key: string, maximum: number) => {
        const number = bounds[key]
        if (
          typeof number !== 'number' ||
          !Number.isSafeInteger(number) ||
          number < 1 ||
          number > maximum
        )
          rejectText('INVALID_REQUEST')
        return number
      }
      const startRow = bounded('startRow', 1048576)
      const endRow = bounded('endRow', 1048576)
      const startColumn = bounded('startColumn', 16384)
      const endColumn = bounded('endColumn', 16384)
      if (startRow > endRow || startColumn > endColumn) rejectText('INVALID_REQUEST')
      range = { startRow, endRow, startColumn, endColumn }
    } else if (sheet.used) {
      range = { ...sheet.used }
    }
    if (range) {
      totalCells += (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1)
      if (totalCells > limits.maxSelectedCells) rejectText('LIMIT_EXCEEDED')
    }
    return {
      sheetId: sheet.sheetId,
      name: sheet.name,
      state: sheet.state,
      range,
    }
  })

  const snapshot = {
    revision: xlsxInspectRevision,
    sourceHash: inspection.sourceHash,
    dateSystem: inspection.dateSystem,
    includeHiddenContent,
    sheets,
  }
  return { snapshot, snapshotHash: textHash(JSON.stringify(snapshot)) }
}

export type KnowledgeXlsxSelectionSnapshot = ReturnType<
  typeof freezeKnowledgeXlsxSelection
>['snapshot']
