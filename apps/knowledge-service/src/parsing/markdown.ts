import { rejectText } from './errors'
import { markdownUnit, type MarkdownUnitKind } from './markdown-unit'

interface MarkdownLine {
  utf16Start: number
  utf16End: number
  pointStart: number
  pointEnd: number
  byteStart: number
  byteEnd: number
  raw: string
  blank: boolean
  heading: null | { level: number; content: string }
}

// Derived navigation only: the heading text on a unit stays raw; path entries are trimmed content capped at 200.
const atxHeading = (raw: string) => {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(raw)
  if (!match) return null
  let content = (match[2] ?? '').trim().replace(/[ \t]+#+[ \t]*$/, '')
  if (content.length > 200) content = content.slice(0, 200)
  return { level: match[1].length, content }
}

// Lenient GFM-lite delimiter row: dash cells with optional colons; cell-count parity with the header is not checked in v1.
const isDelimiterRow = (raw: string) => {
  const trimmed = raw.trim()
  if (!trimmed.includes('|')) return false
  const cells = trimmed.split('|')
  if (cells[0]!.trim() === '') cells.shift()
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === '') cells.pop()
  return cells.length >= 1 && cells.every((cell) => /^[ \t]*:?-+:?[ \t]*$/.test(cell))
}

export function markdownBlocks(
  text: string,
  sourceHash: string,
  bomBytes: number,
  limits: { maxCodePoints: number; maxLines: number },
) {
  const lines: MarkdownLine[] = []
  let utf16Offset = 0
  let pointOffset = 0
  let byteOffset = bomBytes
  let utf16Start = 0
  let pointStart = 0
  let byteStart = bomBytes
  const breakLine = () => {
    if (lines.length >= limits.maxLines) rejectText('LIMIT_EXCEEDED')
    let raw = text.slice(utf16Start, utf16Offset)
    if (raw.endsWith('\n') || raw.endsWith('\r')) raw = raw.slice(0, -1)
    if (raw.endsWith('\r')) raw = raw.slice(0, -1)
    lines.push({
      utf16Start,
      utf16End: utf16Offset,
      pointStart,
      pointEnd: pointOffset,
      byteStart,
      byteEnd: byteOffset,
      raw,
      blank: raw === '' || /^[ \t]+$/.test(raw),
      heading: atxHeading(raw),
    })
    utf16Start = utf16Offset
    pointStart = pointOffset
    byteStart = byteOffset
  }
  // The same single scalar-value pass as text lines: UTF-16 slicing, UTF-8 bytes and code points stay independent.
  for (const point of text) {
    const scalar = point.codePointAt(0)!
    if (
      (scalar < 32 && scalar !== 9 && scalar !== 10 && scalar !== 13) ||
      (scalar >= 127 && scalar <= 159)
    )
      rejectText('BINARY_CONTENT')
    utf16Offset += point.length
    pointOffset += 1
    byteOffset += scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4
    if (pointOffset > limits.maxCodePoints) rejectText('LIMIT_EXCEEDED')
    if (point === '\n' || (point === '\r' && text[utf16Offset] !== '\n')) breakLine()
  }
  if (utf16Start < utf16Offset) breakLine()

  const units: ReturnType<typeof markdownUnit>[] = []
  const headingStack: { level: number; content: string }[] = []
  const pushBlock = (kind: MarkdownUnitKind, start: number, end: number) => {
    const first = lines[start]!
    const last = lines[end]!
    units.push(
      markdownUnit(
        text.slice(first.utf16Start, last.utf16End),
        sourceHash,
        units.length,
        kind,
        first.pointStart,
        last.pointEnd,
        first.byteStart,
        last.byteEnd,
        start + 1,
        end + 1,
        headingStack.map((entry) => entry.content),
      ),
    )
  }
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.blank) {
      index += 1
      continue
    }
    if (line.heading) {
      // The heading unit's path holds only its ancestors: pop the stack before emitting and pushing it.
      while (
        headingStack.length &&
        headingStack[headingStack.length - 1]!.level >= line.heading.level
      )
        headingStack.pop()
      pushBlock('heading', index, index)
      headingStack.push({ level: line.heading.level, content: line.heading.content })
      index += 1
      continue
    }
    if (
      line.raw.includes('|') &&
      index + 1 < lines.length &&
      isDelimiterRow(lines[index + 1]!.raw)
    ) {
      let end = index + 2
      while (
        end < lines.length &&
        !lines[end]!.blank &&
        !lines[end]!.heading &&
        lines[end]!.raw.includes('|')
      )
        end += 1
      pushBlock('table', index, end - 1)
      index = end
      continue
    }
    // A GFM table cannot interrupt a paragraph, so paragraphs run until a blank line or a heading.
    let end = index + 1
    while (end < lines.length && !lines[end]!.blank && !lines[end]!.heading) end += 1
    pushBlock('paragraph', index, end - 1)
    index = end
  }
  return {
    units,
    textCodePointLength: pointOffset,
    nonBlankLines: lines.filter((entry) => !entry.blank).length,
  }
}
