import { invalid, record } from '../validation'
import { locatorContext } from './common'
import { parseDocxLocator } from './docx'
import { parsePdfLocator } from './pdf'
import { parseTextLocator } from './text'
import { parseXlsxLocator } from './xlsx'

function decodeLocator(input: unknown) {
  const source = record(input, 'locator')
  if (source.format === 'pdf') return parsePdfLocator(input)
  if (source.format === 'docx') return parseDocxLocator(input)
  if (source.format === 'md' || source.format === 'txt') return parseTextLocator(input)
  if (source.format === 'xlsx') return parseXlsxLocator(input)
  invalid('locator.format')
}

export function parseKnowledgeLocator(input: unknown, context: unknown) {
  const expected = locatorContext(context, 'locatorContext')
  const result = decodeLocator(input)
  // These bindings check protocol integrity, not database ownership or the hashes themselves.
  if (
    result.format !== expected.format ||
    result.sourceHash !== expected.sourceHash ||
    result.textHash !== expected.textHash
  ) {
    invalid('locator.source')
  }
  if (result.span.end > expected.textCodePointLength) invalid('locator.span.end')
  return result
}

export type KnowledgeLocator = ReturnType<typeof parseKnowledgeLocator>
export type { KnowledgeLocatorContext } from './common'
