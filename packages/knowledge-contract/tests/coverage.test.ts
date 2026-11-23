import { describe, expect, expectTypeOf, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeCoverage } from '../src'
import { hashes } from './locator-fixtures'

const context = {
  format: 'pdf',
  sourceHash: hashes.sourceHash,
  parserRevision: 'synthetic-parser-1',
}
const complete = {
  schemaVersion: 1,
  ...context,
  scope: 'document',
  unit: 'page',
  status: 'complete',
  expectedUnits: 2,
  completedUnits: 2,
  missingUnits: 0,
  excludedUnits: 0,
  warnings: [],
}
const missing = { code: 'MISSING_UNITS', unitOrdinal: 1 }

describe('structural coverage, never retrieval hit counts', () => {
  it('accepts complete/partial/unknown/failed facts without inventing counts', () => {
    expect(parseKnowledgeCoverage(complete, context)).toEqual(complete)
    const partial = {
      ...complete,
      status: 'partial',
      completedUnits: 1,
      missingUnits: 1,
      warnings: [missing],
    }
    expect(parseKnowledgeCoverage(partial, context)).toEqual(partial)
    const unknown = {
      ...complete,
      status: 'unknown',
      expectedUnits: null,
      completedUnits: 0,
      missingUnits: null,
    }
    expect(parseKnowledgeCoverage(unknown, context)).toEqual(unknown)
    const failed = {
      ...complete,
      status: 'failed',
      expectedUnits: 0,
      completedUnits: 0,
      warnings: [{ code: 'EMPTY_CONTENT', unitOrdinal: null }],
    }
    expect(parseKnowledgeCoverage(failed, context)).toEqual(failed)
    expectTypeOf(parseKnowledgeCoverage(complete, context).status).toEqualTypeOf<
      'complete' | 'partial' | 'failed' | 'unknown'
    >()
  })

  it('marks explicitly selected XLSX coverage without claiming the entire workbook', () => {
    const selected = {
      ...complete,
      format: 'xlsx',
      unit: 'cell',
      scope: 'selection',
      excludedUnits: null,
      warnings: [
        { code: 'SELECTION_EXCLUDED', unitOrdinal: null },
        { code: 'FORMULA_CACHE_STALE', unitOrdinal: 0 },
      ],
    }
    const xlsxContext = { ...context, format: 'xlsx' }
    expect(parseKnowledgeCoverage(selected, xlsxContext)).toEqual(selected)
    const unknownValue = {
      ...selected,
      status: 'partial',
      warnings: [...selected.warnings, { code: 'FORMULA_CACHE_MISSING', unitOrdinal: 1 }],
    }
    expect(parseKnowledgeCoverage(unknownValue, xlsxContext)).toEqual(unknownValue)
  })

  it.each([
    { ...complete, completedUnits: 1, missingUnits: 1 },
    { ...complete, completedUnits: 1 },
    { ...complete, expectedUnits: null, missingUnits: null },
    { ...complete, expectedUnits: 0, completedUnits: 0 },
    { ...complete, completedUnits: -1 },
    { ...complete, expectedUnits: '2' },
    { ...complete, unit: 'hit' },
    { ...complete, unit: 'chunk' },
    { ...complete, unit: 'cell' },
    { ...complete, status: 'ready' },
    { ...complete, status: 'partial' },
    { ...complete, status: 'unknown' },
    { ...complete, status: 'failed' },
    { ...complete, excludedUnits: 1 },
    { ...complete, excludedUnits: null },
    { ...complete, scope: 'selection', excludedUnits: 1 },
    { ...complete, sourceHash: 'c'.repeat(64) },
    { ...complete, parserRevision: 'different-parser' },
    { ...complete, ownerId: 'forged' },
  ])('rejects invalid or falsely complete manifests: %j', (input) => {
    expect(() => parseKnowledgeCoverage(input, context)).toThrow(KnowledgeContractError)
  })

  it.each([
    'OCR_REQUIRED',
    'MISSING_UNITS',
    'EXTRACTION_FAILED',
    'GARBLED_TEXT',
    'TABLE_INCOMPLETE',
    'UNSUPPORTED_CONTENT',
  ])('does not hide %s inside an otherwise complete count', (code) => {
    expect(() =>
      parseKnowledgeCoverage({ ...complete, warnings: [{ code, unitOrdinal: 0 }] }, context),
    ).toThrow(KnowledgeContractError)
  })

  it.each([
    { reason: 'ordinal outside the target', warnings: [{ code: 'MISSING_UNITS', unitOrdinal: 2 }] },
    { reason: 'unknown warning code', warnings: [{ code: 'UNKNOWN_WARNING', unitOrdinal: null }] },
    {
      reason: 'raw supplier text',
      warnings: [{ code: 'MISSING_UNITS', unitOrdinal: 1, message: 'Bearer private-token' }],
    },
    {
      reason: 'caller-selected severity',
      warnings: [{ code: 'MISSING_UNITS', unitOrdinal: 1, severity: 'info' }],
    },
    { reason: 'duplicate warnings', warnings: [missing, missing] },
  ])('rejects $reason', ({ warnings }) => {
    expect(() =>
      parseKnowledgeCoverage(
        { ...complete, status: 'partial', completedUnits: 1, missingUnits: 1, warnings },
        context,
      ),
    ).toThrow(KnowledgeContractError)
  })

  it('rejects spreadsheet warnings even when PDF counts are otherwise complete', () => {
    expect(() =>
      parseKnowledgeCoverage(
        { ...complete, warnings: [{ code: 'FORMULA_CACHE_STALE', unitOrdinal: 0 }] },
        context,
      ),
    ).toThrow(KnowledgeContractError)
  })

  it('rejects more than 100 otherwise unique and in-range warnings', () => {
    const warnings = Array.from({ length: 101 }, (_, unitOrdinal) => ({
      code: 'TABLE_INCOMPLETE',
      unitOrdinal,
    }))
    const input = {
      ...complete,
      status: 'partial',
      expectedUnits: 101,
      completedUnits: 100,
      missingUnits: 1,
      warnings,
    }
    expect(() => parseKnowledgeCoverage(input, context)).toThrow(KnowledgeContractError)
  })
})
