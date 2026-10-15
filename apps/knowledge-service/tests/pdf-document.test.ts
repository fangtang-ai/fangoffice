import { createHash } from 'node:crypto'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { expect, it } from 'vitest'
import { KnowledgeTextError, parseKnowledgePdfDocument } from '../src/parsing'

const pdfLimits = { maxBytes: 5 * 1024 * 1024, maxPages: 50, maxTextItems: 5000 }

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function pdfInput(build: (doc: PDFDocument) => Promise<void>) {
  const doc = await PDFDocument.create()
  await build(doc)
  const bytes = await doc.save()
  return { bytes, sourceHash: sha(bytes) }
}

async function helvetica(doc: PDFDocument) {
  return doc.embedFont(StandardFonts.Helvetica)
}

it('produces deterministic per-page DocIR with physical pages, geometry and coverage', async () => {
  const input = await pdfInput(async (doc) => {
    const font = await helvetica(doc)
    const first = doc.addPage([612, 792])
    first.drawText('Intro line alpha', { x: 72, y: 700, size: 12, font })
    first.drawText('Beta follows & <quotes>', { x: 72, y: 680, size: 12, font })
    const second = doc.addPage([612, 792])
    second.drawText('Gamma on page two', { x: 100, y: 720, size: 14, font })
  })
  const document = await parseKnowledgePdfDocument(input, pdfLimits)
  expect(document.format).toBe('pdf')
  expect(document.parserRevision).toBe('pdf-js-text-pages-v1')
  expect(document.sourceBytes).toEqual({ unit: 'bytes', value: String(input.bytes.byteLength) })
  expect(document.text).toContain('Intro line alpha')
  expect(document.text).toContain('Gamma on page two')
  expect(document.units.length).toBe(3)
  for (const unit of document.units) {
    // every unit text sits exactly at its documentSpan inside document.text
    expect(document.text.slice(unit.documentSpan.start, unit.documentSpan.end)).toBe(unit.text)
    expect(unit.locator.span).toEqual({
      unit: 'unicode_code_point',
      origin: 0,
      start: 0,
      end: [...unit.text].length,
    })
    expect(unit.locator.geometry).toMatchObject({
      origin: 'top-left',
      unit: 'pt',
      rotation: 0,
      pageWidth: 612,
      pageHeight: 792,
    })
    const bbox = unit.locator.geometry!.bbox!
    expect(bbox.x0).toBeLessThan(bbox.x1)
    expect(bbox.y0).toBeLessThan(bbox.y1)
    expect(bbox.x0).toBeGreaterThanOrEqual(0)
    expect(bbox.y0).toBeGreaterThanOrEqual(0)
    expect(bbox.x1).toBeLessThanOrEqual(612)
    expect(bbox.y1).toBeLessThanOrEqual(792)
  }
  const pages = new Set(document.units.map((unit) => unit.locator.physicalPage))
  expect(pages).toEqual(new Set([1, 2]))
  const second = document.units.find((unit) => unit.text === 'Gamma on page two')!
  expect(second.locator.physicalPage).toBe(2)
  expect(second.locator.blockIndex).toBe(0)
  expect(document.coverage).toMatchObject({
    status: 'complete',
    unit: 'page',
    expectedUnits: 2,
    completedUnits: 2,
    missingUnits: 0,
  })
  expect(document.preview).not.toContain('<')
  expect(document.preview).toContain('&lt;')
  const again = await parseKnowledgePdfDocument(input, pdfLimits)
  expect(JSON.stringify(again)).toBe(JSON.stringify(document))
})

it('reports display-page geometry after rotation and keeps bbox in display space', async () => {
  const input = await pdfInput(async (doc) => {
    const font = await helvetica(doc)
    const page = doc.addPage([612, 792])
    page.setRotation(degrees(90))
    page.drawText('Rotated line', { x: 100, y: 400, size: 12, font })
  })
  const document = await parseKnowledgePdfDocument(input, pdfLimits)
  expect(document.units.length).toBe(1)
  const geometry = document.units[0]!.locator.geometry!
  expect(geometry.rotation).toBe(90)
  expect(geometry.pageWidth).toBe(792)
  expect(geometry.pageHeight).toBe(612)
  const bbox = geometry.bbox!
  expect(bbox.x0).toBeGreaterThanOrEqual(0)
  expect(bbox.y0).toBeGreaterThanOrEqual(0)
  expect(bbox.x1).toBeLessThanOrEqual(792)
  expect(bbox.y1).toBeLessThanOrEqual(612)
  expect(document.coverage).toMatchObject({ status: 'complete', expectedUnits: 1 })
})

it('flags scanned pages with OCR_REQUIRED and never pretends completeness', async () => {
  const input = await pdfInput(async (doc) => {
    await helvetica(doc)
    doc.addPage([612, 792]) // image-only page: no text operators
    const second = doc.addPage([612, 792])
    second.drawText('Real text here', { x: 72, y: 700, size: 12, font: (await helvetica(doc))! })
  })
  const document = await parseKnowledgePdfDocument(input, pdfLimits)
  expect(document.coverage).toMatchObject({
    status: 'partial',
    expectedUnits: 2,
    completedUnits: 1,
    missingUnits: 1,
  })
  expect(document.coverage.warnings).toContainEqual({ code: 'OCR_REQUIRED', unitOrdinal: 0 })
  expect(document.coverage.warnings).toContainEqual({ code: 'MISSING_UNITS', unitOrdinal: null })
  expect(document.units.map((unit) => unit.locator.physicalPage)).toEqual([2])
  expect(document.text).toContain('Real text here')
})

it('rejects PDFs with no extractable text as empty content', async () => {
  const input = await pdfInput(async (doc) => {
    await helvetica(doc)
    doc.addPage([612, 792])
    doc.addPage([612, 792])
  })
  await expect(parseKnowledgePdfDocument(input, pdfLimits)).rejects.toMatchObject({
    reason: 'EMPTY_CONTENT',
  })
})

it('rejects encrypted PDFs instead of guessing', async () => {
  // hand-built classic-xref PDF with a standard security handler; the /O /U bytes
  // are deliberate garbage so the empty-password derivation fails in pdf.js
  const chunks: string[] = ['%PDF-1.7\n']
  const offsets: number[] = []
  const pageObjects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 700 Td (Secret body) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let cursor = chunks[0].length
  for (const [index, object] of pageObjects.entries()) {
    const body = `${index + 1} 0 obj${object}endobj\n`
    offsets.push(cursor)
    chunks.push(body)
    cursor += body.length
  }
  const encryptOffset = cursor
  chunks.push(
    '999 0 obj<< /Filter /Standard /V 2 /R 4 /O (00000000000000000000000000000000) /U (11111111111111111111111111111111) /P -4438 >>endobj\n',
  )
  const xrefStart = cursor + chunks[chunks.length - 1].length
  let xref = `xref\n0 ${pageObjects.length + 1}\n0000000000 65535 f \n`
  for (let number = 1; number <= pageObjects.length; number += 1) {
    xref += `${String(offsets[number - 1]).padStart(10, '0')} 00000 n \n`
  }
  xref += `999 1\n${String(encryptOffset).padStart(10, '0')} 00000 n \n`
  chunks.push(xref)
  const idHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  chunks.push(
    `trailer\n<< /Size ${pageObjects.length + 2} /Root 1 0 R /Encrypt 999 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  )
  const bytes = new Uint8Array(Buffer.from(chunks.join(''), 'latin1'))
  await expect(
    parseKnowledgePdfDocument({ bytes, sourceHash: sha(bytes) }, pdfLimits),
  ).rejects.toMatchObject({ reason: 'ENCRYPTED_FILE' })
})

it('rejects non-PDF bytes as corrupt container', async () => {
  const bytes = new TextEncoder().encode('this is not a pdf at all')
  await expect(
    parseKnowledgePdfDocument({ bytes, sourceHash: sha(bytes) }, pdfLimits),
  ).rejects.toMatchObject({ reason: 'CORRUPT_CONTAINER' })
})

it('rejects source hash mismatch before parsing', async () => {
  const input = await pdfInput(async (doc) => {
    const font = await helvetica(doc)
    const page = doc.addPage([612, 792])
    page.drawText('Hash check', { x: 72, y: 700, size: 12, font })
  })
  await expect(
    parseKnowledgePdfDocument({ ...input, sourceHash: '0'.repeat(64) }, pdfLimits),
  ).rejects.toBeInstanceOf(KnowledgeTextError)
})

it('enforces page and item limits without silent truncation', async () => {
  const input = await pdfInput(async (doc) => {
    const font = await helvetica(doc)
    const first = doc.addPage([612, 792])
    first.drawText('Alpha', { x: 72, y: 700, size: 12, font })
    const second = doc.addPage([612, 792])
    second.drawText('Beta', { x: 72, y: 700, size: 12, font })
  })
  await expect(
    parseKnowledgePdfDocument(input, { ...pdfLimits, maxPages: 1 }),
  ).rejects.toMatchObject({ reason: 'LIMIT_EXCEEDED' })
  await expect(
    parseKnowledgePdfDocument(input, { ...pdfLimits, maxTextItems: 1 }),
  ).rejects.toMatchObject({ reason: 'LIMIT_EXCEEDED' })
})
