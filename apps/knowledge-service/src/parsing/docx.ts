import type { KnowledgeParseWarning } from '@genoffice/knowledge-contract'
import { rejectText } from './errors'

export type KnowledgeDocxUnitKind = 'heading' | 'paragraph' | 'table_cell'

export interface KnowledgeDocxBlock {
  kind: KnowledgeDocxUnitKind
  text: string
  headingPath: string[]
  table: null | { tableIndex: number; row: number; column: number }
}

type Frame =
  | { name: string; kind: 'other' | 'body' }
  | { name: string; kind: 'fallback' }
  | {
      name: string
      kind: 'p'
      buffer: string[]
      style: string | null
      outline: number | null
      note: boolean
      inCell: boolean
    }
  | { name: string; kind: 'tbl'; tableIndex: number | null; nextRow: number }
  | { name: string; kind: 'tr'; row: number; columns: number }
  | {
      name: string
      kind: 'tc'
      buffer: string[]
      column: number
      hadNested: boolean
      note: boolean
    }

// Strict UTF-8 decode of a container part; malformed bytes mean a corrupt package, not bad input text.
function decodeXml(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    rejectText('CORRUPT_CONTAINER')
  }
}

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g, (entity, body: string) => {
    if (body === 'amp') return '&'
    if (body === 'lt') return '<'
    if (body === 'gt') return '>'
    if (body === 'quot') return '"'
    if (body === 'apos') return "'"
    if (body[0] === '#') {
      const point = Number(body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : body.slice(1))
      // Control characters other than tab/newline/CR are not valid WordprocessingML text.
      if (
        Number.isSafeInteger(point) &&
        (point === 9 || point === 10 || point === 13 || point > 31)
      )
        return String.fromCodePoint(point)
    }
    rejectText('CORRUPT_CONTAINER')
  })
}

function parseAttributes(source: string): Attributes {
  const attributes: Attributes = { val: null }
  const pattern = /([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?\s*=\s*("([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const local = match[2] ?? match[1]
    if (local === 'val') {
      if (attributes.val !== null) rejectText('CORRUPT_CONTAINER')
      attributes.val = decodeEntities(match[4] ?? match[5] ?? '')
    }
  }
  return attributes
}

interface Attributes {
  val: string | null
}

function tagName(fragment: string) {
  const pattern = /^(?:([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?)(\s[^>]*)?$/
  const match = pattern.exec(fragment)
  if (!match) rejectText('CORRUPT_CONTAINER')
  return { prefix: match[1] ?? '', local: match[2] ?? match[1] ?? '', rest: match[3] ?? '' }
}

function findFrame(stack: Frame[], kind: 'p' | 'tc' | 'tbl' | 'tr') {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index]!
    if (frame.kind === kind) return frame
    if (frame.kind === 'body') return null
  }
  return null
}

const prologPattern = /^<\?xml[\s\S]*?\?>/

// Walks the word/document.xml body in reading order and emits content blocks with physical
// positions. Non-tracked elements stay transparent so their w:t text is not dropped silently;
// only mc:Fallback subtrees are skipped because the same content is also in mc:Choice.
export function docxBlocks(xmlBytes: Uint8Array): {
  blocks: KnowledgeDocxBlock[]
  expectedUnits: number
  warnings: KnowledgeParseWarning[]
} {
  const xml = decodeXml(xmlBytes)
  const stack: Frame[] = []
  const blocks: KnowledgeDocxBlock[] = []
  const warnings: KnowledgeParseWarning[] = []
  const headingStack: { level: number; title: string }[] = []
  let tableCounter = 0
  let bodySeen = false

  // Nearest open paragraph or table cell: the target of w:t text, tabs and breaks.
  const target = () => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const frame = stack[index]!
      if (frame.kind === 'p' || frame.kind === 'tc') return frame
      if (frame.kind === 'body') return null
    }
    return null
  }
  const noteFlag = () => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const frame = stack[index]!
      if (frame.kind === 'p' || frame.kind === 'tc') {
        frame.note = true
        return
      }
      if (frame.kind === 'body') return
    }
  }

  let position = 0
  const prolog = prologPattern.exec(xml.slice(0, 200))
  if (prolog) position = prolog[0].length

  const open = (prefix: string, local: string, rest: string, selfClosing: boolean) => {
    if (stack.length === 0) {
      if (local !== 'document') rejectText('CORRUPT_CONTAINER')
      stack.push({ name: local, kind: 'other' })
      return
    }
    const top = stack[stack.length - 1]!
    // mc:Fallback holds a duplicate of mc:Choice content; track depth but never interpret it.
    if (top.kind === 'fallback' || (prefix === 'mc' && local === 'Fallback')) {
      stack.push({ name: local, kind: 'fallback' })
      if (selfClosing) stack.pop()
      return
    }
    switch (local) {
      case 'body': {
        if (top.kind !== 'other' || top.name !== 'document') rejectText('CORRUPT_CONTAINER')
        bodySeen = true
        stack.push({ name: local, kind: 'body' })
        break
      }
      case 'p': {
        stack.push({
          name: local,
          kind: 'p',
          buffer: [],
          style: null,
          outline: null,
          note: false,
          inCell: findFrame(stack, 'tc') !== null,
        })
        break
      }
      case 'tbl': {
        // Nested tables are flattened into the parent cell; they must not consume a table slot.
        const nested = findFrame(stack, 'tbl') !== null || findFrame(stack, 'tc') !== null
        stack.push({
          name: local,
          kind: 'tbl',
          tableIndex: nested ? null : tableCounter++,
          nextRow: 0,
        })
        break
      }
      case 'tr': {
        const table = findFrame(stack, 'tbl')
        if (!table || table.kind !== 'tbl') rejectText('CORRUPT_CONTAINER')
        table.nextRow += 1
        stack.push({ name: local, kind: 'tr', row: table.nextRow, columns: 0 })
        break
      }
      case 'tc': {
        const row = findFrame(stack, 'tr')
        if (!row || row.kind !== 'tr') rejectText('CORRUPT_CONTAINER')
        // v1 column = position among w:tc elements; gridSpan/vMerge merging is not modelled.
        row.columns += 1
        stack.push({
          name: local,
          kind: 'tc',
          buffer: [],
          column: row.columns,
          hadNested: false,
          note: false,
        })
        break
      }
      case 'tab': {
        const frame = target()
        if (frame) frame.buffer.push('\t')
        stack.push({ name: local, kind: 'other' })
        break
      }
      case 'br': {
        const frame = target()
        if (frame) frame.buffer.push('\n')
        stack.push({ name: local, kind: 'other' })
        break
      }
      case 'pStyle': {
        const paragraph = findFrame(stack, 'p')
        if (paragraph && paragraph.kind === 'p') paragraph.style = parseAttributes(rest).val
        stack.push({ name: local, kind: 'other' })
        break
      }
      case 'outlineLvl': {
        const paragraph = findFrame(stack, 'p')
        const value = Number(parseAttributes(rest).val)
        if (
          paragraph &&
          paragraph.kind === 'p' &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= 8
        )
          paragraph.outline = value
        stack.push({ name: local, kind: 'other' })
        break
      }
      case 'footnoteReference':
      case 'endnoteReference':
      case 'altChunk': {
        noteFlag()
        stack.push({ name: local, kind: 'other' })
        break
      }
      default: {
        stack.push({ name: local, kind: 'other' })
      }
    }
    if (selfClosing) stack.pop()
  }

  const close = (local: string) => {
    const frame = stack.pop()
    if (!frame || frame.name !== local) rejectText('CORRUPT_CONTAINER')
    if (frame.kind === 'fallback') return
    if (frame.kind === 'tbl' && frame.tableIndex === null) {
      // A completed nested table marks the enclosing cell: its text is flattened there.
      const cell = findFrame(stack, 'tc')
      if (cell && cell.kind === 'tc') cell.hadNested = true
      return
    }
    if (frame.kind === 'p') {
      if (frame.inCell) {
        const cell = findFrame(stack, 'tc')
        if (cell && cell.kind === 'tc' && frame.buffer.join('').length > 0)
          cell.buffer.push(frame.buffer.join(''))
        return
      }
      const text = frame.buffer.join('')
      if (!text.trim()) return
      const style = frame.style ?? ''
      const styleHeading = /^Heading([1-9])$/i.exec(style)
      const level = styleHeading
        ? Number(styleHeading[1])
        : frame.outline === null
          ? null
          : frame.outline + 1
      const headingPath = headingStack.map((heading) => heading.title).slice(-32)
      if (frame.note) warnings.push({ code: 'UNSUPPORTED_CONTENT', unitOrdinal: blocks.length })
      if (level === null) {
        blocks.push({ kind: 'paragraph', text, headingPath, table: null })
        return
      }
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level)
        headingStack.pop()
      headingStack.push({ level, title: text.slice(0, 200) })
      blocks.push({ kind: 'heading', text, headingPath, table: null })
      return
    }
    if (frame.kind === 'tc') {
      const text = frame.buffer.join('\n')
      if (!text) return
      const parent = findFrame(stack, 'tc')
      if (parent && parent.kind === 'tc') {
        parent.buffer.push(text)
        return
      }
      const table = findFrame(stack, 'tbl')
      const row = findFrame(stack, 'tr')
      if (!table || table.kind !== 'tbl' || table.tableIndex === null || !row || row.kind !== 'tr')
        rejectText('CORRUPT_CONTAINER')
      if (frame.hadNested) warnings.push({ code: 'TABLE_INCOMPLETE', unitOrdinal: blocks.length })
      if (frame.note) warnings.push({ code: 'UNSUPPORTED_CONTENT', unitOrdinal: blocks.length })
      blocks.push({
        kind: 'table_cell',
        text,
        headingPath: headingStack.map((heading) => heading.title).slice(-32),
        table: { tableIndex: table.tableIndex, row: row.row, column: frame.column },
      })
    }
  }

  while (position < xml.length) {
    const lessThan = xml.indexOf('<', position)
    if (lessThan < 0) rejectText('CORRUPT_CONTAINER')
    if (stack[stack.length - 1]?.name === 't') {
      const frame = target()
      if (frame) frame.buffer.push(decodeEntities(xml.slice(position, lessThan)))
    }
    if (xml.startsWith('<!--', lessThan)) {
      const end = xml.indexOf('-->', lessThan + 4)
      if (end < 0) rejectText('CORRUPT_CONTAINER')
      position = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lessThan)) {
      const end = xml.indexOf(']]>', lessThan + 9)
      if (end < 0) rejectText('CORRUPT_CONTAINER')
      if (stack[stack.length - 1]?.name === 't') {
        const frame = target()
        if (frame) frame.buffer.push(xml.slice(lessThan + 9, end))
      }
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
    if (fragment.startsWith('/')) {
      close(tagName(fragment.slice(1)).local)
      position = greaterThan + 1
      continue
    }
    // Crafted attribute values ending in '/' can fake self-closing; that only yields a safe reject.
    const selfClosing = fragment.endsWith('/')
    const { prefix, local, rest } = tagName(selfClosing ? fragment.slice(0, -1) : fragment)
    open(prefix, local, rest, selfClosing)
    position = greaterThan + 1
  }
  if (stack.length !== 0 || !bodySeen) rejectText('CORRUPT_CONTAINER')
  return { blocks, expectedUnits: blocks.length, warnings }
}
