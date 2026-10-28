import { knowledgeSourceFormat } from './core.js'
import { parseKnowledgeCoverage } from './coverage.js'
import { parseKnowledgeLocator } from './locators/index.js'
import { parseWarning } from './warnings.js'
import {
  contentUuid,
  integer,
  invalid,
  list,
  object,
  record,
  sha256,
  text,
  uuid,
} from './validation.js'
const buildFields = { spaceId: uuid, documentId: uuid, versionId: uuid, buildId: uuid }
const sourceTarget = object({ ...buildFields, sourceUnitId: contentUuid })
const sourceUnit = object({
  id: contentUuid,
  ...buildFields,
  indexProfileId: uuid,
  format: knowledgeSourceFormat,
  sourceHash: sha256,
  parserRevision: text(128),
  ordinal: integer(0, 2147483647),
  type: text(64),
  text: (input, path) => {
    if (typeof input !== 'string' || input.length > 8 * 1024 * 1024) invalid(path)
    return input
  },
  textHash: sha256,
  locator: record,
  coverage: record,
  warnings: list(parseWarning, 0, 100),
})

export function parseKnowledgeSourceUnitTarget(input: unknown) {
  return sourceTarget(input, 'sourceUnitTarget')
}

export function parseKnowledgeSourceUnit(input: unknown, target: KnowledgeSourceUnitTarget) {
  const expected = parseKnowledgeSourceUnitTarget(target)
  const result = sourceUnit(input, 'sourceUnit')
  for (const key of ['spaceId', 'documentId', 'versionId', 'buildId'] as const)
    if (result[key] !== expected[key]) invalid(`sourceUnit.${key}`)
  if (result.id !== expected.sourceUnitId) invalid('sourceUnit.id')
  let textCodePointLength = 0
  for (const point of result.text) {
    const scalar = point.codePointAt(0)!
    if (scalar >= 0xd800 && scalar <= 0xdfff) invalid('sourceUnit.text')
    textCodePointLength += 1
  }
  if (textCodePointLength > 4 * 1024 * 1024) invalid('sourceUnit.text')
  return {
    ...result,
    locator: parseKnowledgeLocator(result.locator, {
      format: result.format,
      sourceHash: result.sourceHash,
      textHash: result.textHash,
      textCodePointLength,
    }),
    coverage: parseKnowledgeCoverage(result.coverage, {
      format: result.format,
      sourceHash: result.sourceHash,
      parserRevision: result.parserRevision,
    }),
  }
}

export type KnowledgeSourceUnitTarget = ReturnType<typeof parseKnowledgeSourceUnitTarget>
export type KnowledgeSourceUnit = ReturnType<typeof parseKnowledgeSourceUnit>
