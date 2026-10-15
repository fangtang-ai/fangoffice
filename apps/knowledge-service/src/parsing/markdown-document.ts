import { parseKnowledgeCoverage } from '@genoffice/knowledge-contract'
import { rejectText } from './errors'
import { textRequest } from './request'
import { decodeSource, markdownParserRevision, textHash } from './text-unit'
import { markdownBlocks } from './markdown'

const previewEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function parseKnowledgeMarkdownDocument(value: unknown, policy: unknown) {
  const { input, limits } = textRequest(value, policy)
  if (textHash(input.bytes) !== input.sourceHash) rejectText('SOURCE_MISMATCH')
  const removedBomBytes =
    input.bytes[0] === 0xef && input.bytes[1] === 0xbb && input.bytes[2] === 0xbf ? 3 : 0
  const text = decodeSource(input.bytes, removedBomBytes)
  if (!text.trim()) rejectText('EMPTY_CONTENT')
  const { units, textCodePointLength, nonBlankLines } = markdownBlocks(
    text,
    input.sourceHash,
    removedBomBytes,
    limits,
  )
  const source = {
    format: 'md' as const,
    sourceHash: input.sourceHash,
    parserRevision: markdownParserRevision,
  }
  const coverage = parseKnowledgeCoverage(
    {
      schemaVersion: 1,
      ...source,
      scope: 'document',
      unit: 'line',
      status: 'complete',
      // The md coverage population is non-blank source lines; every one is inside exactly one emitted block.
      expectedUnits: nonBlankLines,
      completedUnits: nonBlankLines,
      missingUnits: 0,
      excludedUnits: 0,
      warnings: [],
    },
    source,
  )
  return {
    schemaVersion: 1 as const,
    ...source,
    encoding: 'utf-8' as const,
    sourceBytes: { unit: 'bytes' as const, value: String(input.bytes.byteLength) },
    removedBomBytes,
    text,
    textHash: textHash(text),
    textCodePointLength,
    units,
    coverage,
    // Derived safe preview: entity-escaped so renderers can never execute HTML/scripts; cited unit text stays raw.
    preview: text.replace(/[&<>"']/g, (character) => previewEscapes[character]!),
  }
}

export type KnowledgeMarkdownDocument = ReturnType<typeof parseKnowledgeMarkdownDocument>
