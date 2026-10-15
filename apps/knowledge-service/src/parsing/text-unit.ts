import { createHash } from 'node:crypto'
import { parseKnowledgeLocator } from '@genoffice/knowledge-contract'
import { rejectText } from './errors'

export const textParserRevision = 'txt-utf8-lines-v1'
export const markdownParserRevision = 'markdown-atx-blocks-v1'

// One strict decode path for every text-family parser: fatal UTF-8, BOM already stripped by the caller.
export function decodeSource(bytes: Uint8Array, bomBytes: number) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(bomBytes),
    )
  } catch {
    rejectText('INVALID_UTF8')
  }
}
export const textHash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
export const codePointSpan = (start: number, end: number) => ({
  unit: 'unicode_code_point' as const,
  origin: 0 as const,
  start,
  end,
})

export function textUnit(
  text: string,
  sourceHash: string,
  ordinal: number,
  pointStart: number,
  pointEnd: number,
  byteStart: number,
  byteEnd: number,
) {
  const hash = textHash(text)
  const locator = {
    schemaVersion: 1 as const,
    format: 'txt' as const,
    sourceHash,
    textHash: hash,
    span: codePointSpan(0, pointEnd - pointStart),
    headingPath: [],
    lines: {
      unit: 'line' as const,
      origin: 1 as const,
      boundary: 'inclusive' as const,
      start: ordinal + 1,
      end: ordinal + 1,
    },
  }
  parseKnowledgeLocator(locator, {
    format: 'txt',
    sourceHash,
    textHash: hash,
    textCodePointLength: pointEnd - pointStart,
  })
  return {
    id: textHash(`${textParserRevision}:${sourceHash}:${ordinal}:${hash}`),
    ordinal,
    kind: 'line' as const,
    text,
    textHash: hash,
    locator,
    documentSpan: codePointSpan(pointStart, pointEnd),
    sourceByteRange: { unit: 'byte' as const, origin: 0 as const, start: byteStart, end: byteEnd },
  }
}
