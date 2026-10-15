import { parseKnowledgeCodePointRange } from '../code-points'
import { knowledgeSourceFormat } from '../core'
import { integer, list, literal, object, sha256, text } from '../validation'

export const locatorFields = {
  schemaVersion: literal(1),
  sourceHash: sha256,
  textHash: sha256,
  span: parseKnowledgeCodePointRange,
}

export const headingPath = list(text(200), 0, 32)

export const locatorContext = object({
  format: knowledgeSourceFormat,
  sourceHash: sha256,
  textHash: sha256,
  textCodePointLength: integer(0, 2147483647),
})

export type KnowledgeLocatorContext = ReturnType<typeof locatorContext>
