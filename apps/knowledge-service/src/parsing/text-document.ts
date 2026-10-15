import { parseKnowledgeCoverage } from '@genoffice/knowledge-contract'
import { rejectText } from './errors'
import { textRequest } from './request'
import { decodeSource, textHash, textParserRevision } from './text-unit'
import { textLines } from './text-lines'

export function parseKnowledgeTextDocument(value: unknown, policy: unknown) {
  const { input, limits } = textRequest(value, policy)
  if (textHash(input.bytes) !== input.sourceHash) rejectText('SOURCE_MISMATCH')
  const removedBomBytes =
    input.bytes[0] === 0xef && input.bytes[1] === 0xbb && input.bytes[2] === 0xbf ? 3 : 0
  const text = decodeSource(input.bytes, removedBomBytes)
  if (!text.trim()) rejectText('EMPTY_CONTENT')
  const { units, textCodePointLength } = textLines(text, input.sourceHash, removedBomBytes, limits)
  const source = {
    format: 'txt' as const,
    sourceHash: input.sourceHash,
    parserRevision: textParserRevision,
  }
  const coverage = parseKnowledgeCoverage(
    {
      schemaVersion: 1,
      ...source,
      scope: 'document',
      unit: 'line',
      status: 'complete',
      expectedUnits: units.length,
      completedUnits: units.length,
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
  }
}

export type KnowledgeTextDocument = ReturnType<typeof parseKnowledgeTextDocument>
