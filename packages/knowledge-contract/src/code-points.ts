import { integer, invalid, literal, object } from './validation.js'

export const codePointRange = object({
  unit: literal('unicode_code_point'),
  origin: literal(0),
  start: integer(0, 2147483647),
  end: integer(0, 2147483647),
})

export function parseKnowledgeCodePointRange(input: unknown) {
  const result = codePointRange(input, 'codePointRange')
  if (result.start >= result.end) invalid('codePointRange.end')
  return result
}

export function sliceKnowledgeCodePoints(source: unknown, input: unknown) {
  if (typeof source !== 'string') invalid('sourceText')
  const range = parseKnowledgeCodePointRange(input)
  let ordinal = 0
  let offset = 0
  let startOffset = 0
  // Locate UTF-16 boundaries in one pass without copying the whole source into an array.
  for (const codePoint of source) {
    if (ordinal === range.start) startOffset = offset
    offset += codePoint.length
    ordinal += 1
    if (ordinal === range.end) return source.slice(startOffset, offset)
  }
  invalid('codePointRange.end')
}

export type KnowledgeCodePointRange = ReturnType<typeof parseKnowledgeCodePointRange>
