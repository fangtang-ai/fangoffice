import { parseKnowledgeLocator } from '@genoffice/knowledge-contract'
import { codePointSpan, markdownParserRevision, textHash } from './text-unit'

export type MarkdownUnitKind = 'heading' | 'paragraph' | 'table'

export function markdownUnit(
  text: string,
  sourceHash: string,
  ordinal: number,
  kind: MarkdownUnitKind,
  pointStart: number,
  pointEnd: number,
  byteStart: number,
  byteEnd: number,
  lineStart: number,
  lineEnd: number,
  headingPath: string[],
) {
  const hash = textHash(text)
  const locator = {
    schemaVersion: 1 as const,
    format: 'md' as const,
    sourceHash,
    textHash: hash,
    span: codePointSpan(0, pointEnd - pointStart),
    headingPath,
    lines: {
      unit: 'line' as const,
      origin: 1 as const,
      boundary: 'inclusive' as const,
      start: lineStart,
      end: lineEnd,
    },
  }
  parseKnowledgeLocator(locator, {
    format: 'md',
    sourceHash,
    textHash: hash,
    textCodePointLength: pointEnd - pointStart,
  })
  return {
    id: textHash(`${markdownParserRevision}:${sourceHash}:${ordinal}:${hash}`),
    ordinal,
    kind,
    text,
    textHash: hash,
    locator,
    documentSpan: codePointSpan(pointStart, pointEnd),
    sourceByteRange: { unit: 'byte' as const, origin: 0 as const, start: byteStart, end: byteEnd },
  }
}
