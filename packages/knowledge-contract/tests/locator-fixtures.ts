import type { KnowledgeVersion } from '../src'

export const hashes = { sourceHash: 'a'.repeat(64), textHash: 'b'.repeat(64) }
export const baseLocator = {
  schemaVersion: 1,
  ...hashes,
  span: { unit: 'unicode_code_point', origin: 0, start: 0, end: 5 },
}

export function locatorContext(format: KnowledgeVersion['format']) {
  return { format, ...hashes, textCodePointLength: 5 }
}

export const pdfLocator = {
  ...baseLocator,
  format: 'pdf',
  physicalPage: 1,
  blockIndex: 0,
  spanIndex: null,
  geometry: {
    pageWidth: 612,
    pageHeight: 792,
    rotation: 0,
    origin: 'top-left',
    unit: 'pt',
    bbox: { x0: 10, y0: 20, x1: 200, y1: 50 },
  },
}
