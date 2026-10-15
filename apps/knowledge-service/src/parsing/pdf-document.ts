import { parseKnowledgeCoverage, parseKnowledgeLocator } from '@genoffice/knowledge-contract'
import { KnowledgeTextError, rejectText } from './errors'
import { pdfNodeBootstrap } from './pdf-bootstrap'
import { pdfRequest } from './request'
import { codePointSpan, textHash } from './text-unit'

export const pdfParserRevision = 'pdf-js-text-pages-v1'

// Same derived safe preview as the other parsers: entity-escaped so renderers can
// never execute HTML/scripts; cited unit text stays raw.
const previewEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api'

type TextRun = {
  str: string
  hasEOL: boolean
  width: number
  height: number
  transform: number[]
}

const isTextRun = (item: TextItem | TextMarkedContent): item is TextItem =>
  'str' in item &&
  typeof item.str === 'string' &&
  typeof item.hasEOL === 'boolean' &&
  typeof item.width === 'number' &&
  typeof item.height === 'number' &&
  Array.isArray(item.transform) &&
  item.transform.length === 6 &&
  item.transform.every((value) => typeof value === 'number' && Number.isFinite(value))

// bbox edge slack for float noise from the viewport transform chain.
const EPS = 1e-6

export async function parseKnowledgePdfDocument(value: unknown, policy: unknown) {
  const { input, limits } = pdfRequest(value, policy)
  if (textHash(input.bytes) !== input.sourceHash) rejectText('SOURCE_MISMATCH')
  if (
    input.bytes.length < 5 ||
    input.bytes[0] !== 0x25 ||
    input.bytes[1] !== 0x50 ||
    input.bytes[2] !== 0x44 ||
    input.bytes[3] !== 0x46 ||
    input.bytes[4] !== 0x2d
  )
    rejectText('CORRUPT_CONTAINER')
  const fontUrl = await pdfNodeBootstrap()
  const { getDocument, PasswordException, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = getDocument({
    // pdfjs transfers the given buffer, so pass a copy
    data: new Uint8Array(input.bytes),
    useSystemFonts: true,
    ...(fontUrl ? { standardFontDataUrl: fontUrl } : {}),
    verbosity: 0,
  })
  let doc
  try {
    doc = await loadingTask.promise
  } catch (error) {
    if (error instanceof PasswordException) rejectText('ENCRYPTED_FILE')
    rejectText('CORRUPT_CONTAINER')
  }
  try {
    if (doc.numPages > limits.maxPages) rejectText('LIMIT_EXCEEDED')
    const pageCount = doc.numPages
    const source = {
      format: 'pdf' as const,
      sourceHash: input.sourceHash,
      parserRevision: pdfParserRevision,
    }
    let text = ''
    let runCount = 0
    const coveredPages = new Array<boolean>(pageCount).fill(false)
    const warnings: { code: string; unitOrdinal: number | null }[] = []
    // Recorded per text run; units are built after the full walk so spans reference final text.
    const runs: {
      start: number
      end: number
      text: string
      page: number
      blockIndex: number
      pageWidth: number
      pageHeight: number
      viewportTransform: number[]
      rotation: 0 | 90 | 180 | 270
      run: TextRun
    }[] = []
    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
      let viewport
      let content
      try {
        const page = await doc.getPage(pageIndex)
        viewport = page.getViewport({ scale: 1 })
        content = await page.getTextContent()
        const rotation = page.rotate
        if (text.length > 0) text += '\n'
        const items = content.items.filter(isTextRun)
        let blockIndex = 0
        for (let k = 0; k < items.length; k += 1) {
          const run = items[k]!
          if (run.str.length > 0) {
            if (runCount >= limits.maxTextItems) rejectText('LIMIT_EXCEEDED')
            const start = text.length
            text += run.str
            runCount += 1
            if (run.str.trim()) {
              runs.push({
                start,
                end: text.length,
                text: run.str,
                page: pageIndex,
                blockIndex,
                pageWidth: viewport.width,
                pageHeight: viewport.height,
                viewportTransform: viewport.transform,
                rotation: (rotation === 90 || rotation === 180 || rotation === 270
                  ? rotation
                  : 0) as 0 | 90 | 180 | 270,
                run,
              })
              blockIndex += 1
            }
          }
          // page separator covers the last line break of a page
          if (run.hasEOL && k < items.length - 1) text += '\n'
        }
        coveredPages[pageIndex - 1] = blockIndex > 0
        page.cleanup()
      } catch (error) {
        if (error instanceof KnowledgeTextError) throw error
        // missing/unreadable page: recorded, never faked as complete
        warnings.push({ code: 'EXTRACTION_FAILED', unitOrdinal: pageIndex - 1 })
      }
    }
    if (!text.trim()) rejectText('EMPTY_CONTENT')
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1)
      if (!coveredPages[pageIndex]) warnings.push({ code: 'OCR_REQUIRED', unitOrdinal: pageIndex })
    if (coveredPages.some((covered) => !covered))
      warnings.push({ code: 'MISSING_UNITS', unitOrdinal: null })
    const textCodePointLength = [...text].length
    const units = runs.map((entry, ordinal) => {
      const length = [...entry.text].length
      const hash = textHash(entry.text)
      const tx = Util.transform(entry.viewportTransform, entry.run.transform)
      const height = entry.run.height > 0 ? entry.run.height : Math.hypot(tx[2]!, tx[3]!)
      let bbox: { x0: number; y0: number; x1: number; y1: number } | null = null
      if (entry.run.width > EPS && height > EPS) {
        // glyph box corners in run space (baseline start, advance, ascent) through
        // viewport x run transform; result is display-page space (top-left origin)
        const xs: number[] = []
        const ys: number[] = []
        for (const [u, v] of [
          [0, 0],
          [entry.run.width, 0],
          [0, height],
          [entry.run.width, height],
        ]) {
          xs.push(tx[0]! * u + tx[2]! * v + tx[4]!)
          ys.push(tx[1]! * u + tx[3]! * v + tx[5]!)
        }
        const clamp = (point: number, max: number) => Math.min(Math.max(point, 0), max)
        const x0 = clamp(Math.min(...xs), entry.pageWidth)
        const x1 = clamp(Math.max(...xs), entry.pageWidth)
        const y0 = clamp(Math.min(...ys), entry.pageHeight)
        const y1 = clamp(Math.max(...ys), entry.pageHeight)
        if (x1 - x0 > EPS && y1 - y0 > EPS) bbox = { x0, y0, x1, y1 }
      }
      const locator = {
        schemaVersion: 1 as const,
        format: 'pdf' as const,
        sourceHash: input.sourceHash,
        textHash: hash,
        span: codePointSpan(0, length),
        physicalPage: entry.page,
        blockIndex: entry.blockIndex,
        spanIndex: null,
        geometry: {
          pageWidth: entry.pageWidth,
          pageHeight: entry.pageHeight,
          rotation: entry.rotation,
          origin: 'top-left' as const,
          unit: 'pt' as const,
          bbox,
        },
      }
      parseKnowledgeLocator(locator, {
        format: 'pdf',
        sourceHash: input.sourceHash,
        textHash: hash,
        textCodePointLength: length,
      })
      return {
        id: textHash(`${pdfParserRevision}:${input.sourceHash}:${ordinal}:${hash}`),
        ordinal,
        kind: 'line' as const,
        text: entry.text,
        textHash: hash,
        locator,
        documentSpan: codePointSpan(entry.start, entry.end),
      }
    })
    const expectedUnits = pageCount
    const completedUnits = coveredPages.filter(Boolean).length
    const coverage = parseKnowledgeCoverage(
      {
        schemaVersion: 1,
        ...source,
        scope: 'document',
        unit: 'page',
        status:
          completedUnits === expectedUnits && expectedUnits > 0 && warnings.length === 0
            ? 'complete'
            : 'partial',
        expectedUnits,
        completedUnits,
        missingUnits: expectedUnits - completedUnits,
        excludedUnits: 0,
        warnings,
      },
      source,
    )
    return {
      schemaVersion: 1 as const,
      ...source,
      sourceBytes: { unit: 'bytes' as const, value: String(input.bytes.byteLength) },
      text,
      textHash: textHash(text),
      textCodePointLength,
      units,
      coverage,
      preview: text.replace(/[&<>"']/g, (character) => previewEscapes[character]!),
    }
  } finally {
    await loadingTask.destroy()
  }
}

export type KnowledgePdfDocument = Awaited<ReturnType<typeof parseKnowledgePdfDocument>>
