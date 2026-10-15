import { parseKnowledgeCoverage, parseKnowledgeLocator } from '@genoffice/knowledge-contract'
import { rejectText } from './errors'
import { docxBlocks } from './docx'
import { docxRequest } from './request'
import { codePointSpan, textHash } from './text-unit'
import { readZipEntry, zipEntries } from './zip'

export const docxParserRevision = 'docx-ooxml-blocks-v1'

// Block texts join with '\n' to form the virtual document text; spans cover that text.
const previewEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function parseKnowledgeDocxDocument(value: unknown, policy: unknown) {
  const { input, limits } = docxRequest(value, policy)
  if (textHash(input.bytes) !== input.sourceHash) rejectText('SOURCE_MISMATCH')
  // shortcut: main part is fixed to word/document.xml; .rels main-part resolution comes with real-package cases.
  const documentEntry = zipEntries(input.bytes).find((entry) => entry.name === 'word/document.xml')
  if (!documentEntry) rejectText('CORRUPT_CONTAINER')
  const xmlBytes = readZipEntry(input.bytes, documentEntry, limits.maxXmlBytes)
  const { blocks, expectedUnits, warnings } = docxBlocks(xmlBytes)
  const text = blocks.map((block) => block.text).join('\n')
  if (!text.trim()) rejectText('EMPTY_CONTENT')
  // WordprocessingML forbids control characters; a crafted container must not smuggle them in.
  const pointLengths = blocks.map((block) => {
    let points = 0
    for (const point of block.text) {
      const scalar = point.codePointAt(0)!
      if (
        (scalar < 32 && scalar !== 9 && scalar !== 10 && scalar !== 13) ||
        (scalar >= 127 && scalar <= 159)
      )
        rejectText('BINARY_CONTENT')
      points += 1
    }
    return points
  })
  const textCodePointLength =
    pointLengths.reduce((sum, length) => sum + length, 0) + Math.max(0, blocks.length - 1)

  const source = {
    format: 'docx' as const,
    sourceHash: input.sourceHash,
    parserRevision: docxParserRevision,
  }
  const units = blocks.slice(0, limits.maxBlocks).map((block, ordinal) => {
    const pointStart = pointLengths.slice(0, ordinal).reduce((sum, length) => sum + length + 1, 0)
    const pointEnd = pointStart + pointLengths[ordinal]!
    const hash = textHash(block.text)
    const locator = {
      schemaVersion: 1 as const,
      format: 'docx' as const,
      sourceHash: input.sourceHash,
      textHash: hash,
      span: codePointSpan(0, pointEnd - pointStart),
      headingPath: block.headingPath,
      blockIndex: ordinal,
      table: block.table
        ? ({
            unit: 'table_cell' as const,
            origin: 1 as const,
            tableIndex: block.table.tableIndex,
            row: block.table.row,
            column: block.table.column,
          } as const)
        : null,
    }
    parseKnowledgeLocator(locator, {
      format: 'docx',
      sourceHash: input.sourceHash,
      textHash: hash,
      textCodePointLength: pointEnd - pointStart,
    })
    return {
      id: textHash(`${docxParserRevision}:${input.sourceHash}:${ordinal}:${hash}`),
      ordinal,
      kind: block.kind,
      text: block.text,
      textHash: hash,
      locator,
      documentSpan: codePointSpan(pointStart, pointEnd),
    }
  })
  const missingUnits = expectedUnits - units.length
  const coverage = parseKnowledgeCoverage(
    {
      schemaVersion: 1,
      ...source,
      scope: 'document',
      unit: 'block',
      status:
        missingUnits === 0 && warnings.length === 0 && expectedUnits > 0 ? 'complete' : 'partial',
      expectedUnits,
      completedUnits: units.length,
      missingUnits,
      excludedUnits: 0,
      warnings:
        missingUnits > 0 ? [...warnings, { code: 'MISSING_UNITS', unitOrdinal: null }] : warnings,
    },
    source,
  )
  return {
    schemaVersion: 1 as const,
    ...source,
    encoding: 'utf-8' as const,
    sourceBytes: { unit: 'bytes' as const, value: String(input.bytes.byteLength) },
    text,
    textHash: textHash(text),
    textCodePointLength,
    units,
    coverage,
    // Derived safe preview: entity-escaped so renderers can never execute HTML/scripts; cited unit text stays raw.
    preview: text.replace(/[&<>"']/g, (character) => previewEscapes[character]!),
  }
}

export type KnowledgeDocxDocument = ReturnType<typeof parseKnowledgeDocxDocument>
