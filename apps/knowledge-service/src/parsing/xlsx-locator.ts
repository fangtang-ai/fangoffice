import { parseKnowledgeLocator } from '@genoffice/knowledge-contract'
import { codePointSpan, textHash } from './text-unit'
import { xlsxA1, type XlsxRange } from './xlsx-grid'
import type { KnowledgeXlsxSelectionSnapshot } from './xlsx-inspect'

export function xlsxTextLength(text: string) {
  let count = 0
  for (const _point of text) count += 1
  return count
}

export function createXlsxLocator(sourceHash: string, dateSystem: '1900' | '1904') {
  return (
    text: string,
    sheet: KnowledgeXlsxSelectionSnapshot['sheets'][number],
    range: XlsxRange,
  ) => {
    const length = xlsxTextLength(text)
    const locator = {
      schemaVersion: 1 as const,
      format: 'xlsx' as const,
      sourceHash,
      textHash: textHash(text),
      span: codePointSpan(0, length),
      sheetId: sheet.sheetId,
      sheetName: sheet.name,
      dateSystem,
      range: {
        unit: 'cell' as const,
        origin: 1 as const,
        boundary: 'inclusive' as const,
        ...range,
      },
      a1: xlsxA1(range),
    }
    parseKnowledgeLocator(locator, {
      format: 'xlsx',
      sourceHash,
      textHash: locator.textHash,
      textCodePointLength: length,
    })
    return locator
  }
}
