import { choice, integer, nullable, object } from './validation.js'

export const parseWarning = object({
  code: choice([
    'OCR_REQUIRED',
    'EMPTY_CONTENT',
    'MISSING_UNITS',
    'EXTRACTION_FAILED',
    'GARBLED_TEXT',
    'TABLE_INCOMPLETE',
    'HIDDEN_CONTENT_EXCLUDED',
    'SELECTION_EXCLUDED',
    'FORMULA_CACHE_STALE',
    'FORMULA_CACHE_MISSING',
    'UNSUPPORTED_NUMBER_FORMAT',
    'UNSUPPORTED_CONTENT',
  ]),
  unitOrdinal: nullable(integer(0, 2147483647)),
})

export type KnowledgeParseWarning = ReturnType<typeof parseWarning>
export type KnowledgeParseWarningCode = KnowledgeParseWarning['code']

export const blockingWarningCodes: ReadonlySet<KnowledgeParseWarningCode> = new Set([
  'OCR_REQUIRED',
  'EMPTY_CONTENT',
  'MISSING_UNITS',
  'EXTRACTION_FAILED',
  'GARBLED_TEXT',
  'TABLE_INCOMPLETE',
  'FORMULA_CACHE_MISSING',
  'UNSUPPORTED_CONTENT',
])
export const xlsxWarningCodes: ReadonlySet<KnowledgeParseWarningCode> = new Set([
  'FORMULA_CACHE_STALE',
  'FORMULA_CACHE_MISSING',
  'UNSUPPORTED_NUMBER_FORMAT',
])
