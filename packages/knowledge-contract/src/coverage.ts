import { knowledgeSourceFormat } from './core.js'
import { blockingWarningCodes, parseWarning, xlsxWarningCodes } from './warnings.js'
import {
  choice,
  integer,
  invalid,
  list,
  literal,
  nullable,
  object,
  sha256,
  text,
  unique,
} from './validation.js'

const coverageSource = {
  format: knowledgeSourceFormat,
  sourceHash: sha256,
  parserRevision: text(128),
}
const coverageContext = object(coverageSource)
const coverage = object({
  schemaVersion: literal(1),
  ...coverageSource,
  scope: choice(['document', 'selection']),
  unit: choice(['page', 'block', 'line', 'cell']),
  status: choice(['complete', 'partial', 'failed', 'unknown']),
  expectedUnits: nullable(integer(0, 2147483647)),
  completedUnits: integer(0, 2147483647),
  missingUnits: nullable(integer(0, 2147483647)),
  excludedUnits: nullable(integer(0, 2147483647)),
  warnings: list(parseWarning, 0, 100),
})
const unitByFormat = { pdf: 'page', docx: 'block', md: 'line', txt: 'line', xlsx: 'cell' } as const

export function parseKnowledgeCoverage(input: unknown, context: unknown) {
  const expected = coverageContext(context, 'coverageContext')
  const result = coverage(input, 'coverage')
  if (
    result.format !== expected.format ||
    result.sourceHash !== expected.sourceHash ||
    result.parserRevision !== expected.parserRevision
  ) {
    invalid('coverage.source')
  }
  if (result.unit !== unitByFormat[result.format]) invalid('coverage.unit')
  const { expectedUnits, completedUnits, missingUnits, excludedUnits, warnings } = result
  if ((expectedUnits === null) !== (missingUnits === null)) invalid('coverage.missingUnits')
  if (
    expectedUnits !== null &&
    missingUnits !== null &&
    completedUnits + missingUnits !== expectedUnits
  ) {
    invalid('coverage.expectedUnits')
  }
  if (result.scope === 'document' && excludedUnits !== 0) invalid('coverage.excludedUnits')
  if (
    result.scope === 'selection' &&
    excludedUnits !== 0 &&
    !warnings.some(
      (warning) =>
        warning.code === 'SELECTION_EXCLUDED' || warning.code === 'HIDDEN_CONTENT_EXCLUDED',
    )
  )
    invalid('coverage.warnings')
  unique(warnings, (warning) => `${warning.code}:${warning.unitOrdinal}`, 'coverage.warnings')
  for (const warning of warnings) {
    if (
      warning.unitOrdinal !== null &&
      expectedUnits !== null &&
      warning.unitOrdinal >= expectedUnits
    ) {
      invalid('coverage.warnings.unitOrdinal')
    }
    if (result.format !== 'xlsx' && xlsxWarningCodes.has(warning.code))
      invalid('coverage.warnings.code')
  }
  // Counts describe the requested structure, not search hits or proof of fact correctness.
  const blocked = warnings.some((warning) => blockingWarningCodes.has(warning.code))
  if (missingUnits !== null && missingUnits > 0 && !blocked) invalid('coverage.warnings')
  if (
    result.status === 'complete' &&
    (expectedUnits === null || expectedUnits === 0 || missingUnits !== 0 || blocked)
  ) {
    invalid('coverage.status')
  }
  if (
    result.status === 'partial' &&
    (completedUnits === 0 || (expectedUnits !== null && missingUnits === 0 && !blocked))
  ) {
    invalid('coverage.status')
  }
  if (result.status === 'failed' && (completedUnits !== 0 || !blocked)) invalid('coverage.status')
  if (result.status === 'unknown' && (expectedUnits !== null || completedUnits !== 0))
    invalid('coverage.status')
  return result
}

export type KnowledgeCoverage = ReturnType<typeof parseKnowledgeCoverage>
export type KnowledgeCoverageContext = ReturnType<typeof coverageContext>
