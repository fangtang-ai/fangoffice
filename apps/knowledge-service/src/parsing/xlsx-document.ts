import {
  parseKnowledgeCoverage,
  type KnowledgeParseWarningCode,
} from '@genoffice/knowledge-contract'
import { rejectText } from './errors'
import { xlsxDocumentRequest } from './request'
import { textHash } from './text-unit'
import { resolvePartTarget } from './xlsx-inspect'
import { createXlsxLocator, xlsxTextLength } from './xlsx-locator'
import { xlsxRows } from './xlsx-rows'
import { xlsxDocumentSelection } from './xlsx-selection'
import { xlsxTables } from './xlsx-styles'
import { openXlsxPackage, xmlAttribute, xmlChildren, type XlsxXmlNode } from './xlsx-xml'

export const xlsxParserRevision = 'xlsx-selected-rows-v1'

function child(node: XlsxXmlNode | null, name: string) {
  const roots = node ? xmlChildren(node, name) : []
  if (roots.length !== 1) rejectText('CORRUPT_CONTAINER')
  return roots[0]!
}

export function parseKnowledgeXlsxDocument(value: unknown, policy: unknown) {
  const request = xlsxDocumentRequest(value, policy)
  const { input, limits } = request
  if (textHash(input.bytes) !== input.sourceHash) rejectText('SOURCE_MISMATCH')
  // Bound aggregate XML bytes before preflight expands any of the workbook parts.
  const archive = openXlsxPackage(input.bytes, limits.maxXmlBytes)
  const { snapshot, inspection } = xlsxDocumentSelection(request)
  const tables = xlsxTables(archive)
  const workbook = child(archive.xml('xl/workbook.xml'), 'workbook')
  const declared = xmlChildren(child(workbook, 'sheets'), 'sheet')
  const relationships = xmlChildren(
    child(archive.xml('xl/_rels/workbook.xml.rels'), 'Relationships'),
    'Relationship',
  )
  const locator = createXlsxLocator(input.sourceHash, snapshot.dateSystem)
  const budget = { cells: 0, points: 0 }
  const warningCodes = new Set<KnowledgeParseWarningCode>()
  const units = snapshot.sheets
    .flatMap((sheet) => {
      const declaration = declared.find((node) => xmlAttribute(node, 'sheetId') === sheet.sheetId)
      const relation = relationships.find(
        (node) => xmlAttribute(node, 'Id') === (declaration && xmlAttribute(declaration, 'r:id')),
      )
      const target = relation && xmlAttribute(relation, 'Target')
      if (!target) rejectText('CORRUPT_CONTAINER')
      const worksheet = child(
        archive.xml(resolvePartTarget(target, xmlAttribute(relation!, 'TargetMode'))),
        'worksheet',
      )
      const result = xlsxRows(worksheet, sheet, {
        limits,
        tables,
        dateSystem: snapshot.dateSystem,
        includeHiddenContent: snapshot.includeHiddenContent,
        locator,
        budget,
      })
      for (const code of result.warnings) warningCodes.add(code)
      return result.rows
    })
    .map((unit, ordinal) => ({
      ...unit,
      ordinal,
      id: textHash(
        `${xlsxParserRevision}:${input.sourceHash}:${request.snapshotHash}:${unit.sheetId}:${unit.row}:${unit.textHash}`,
      ),
      kind: 'row' as const,
    }))
  const cells = units.flatMap((unit) => unit.cells)
  if (!cells.length || cells.every((cell) => cell.type === 'blank' && cell.known))
    rejectText('EMPTY_CONTENT')
  const text = units.map((unit) => unit.text).join('\n')
  const excludedUnits =
    inspection.sheets.reduce((count, sheet) => count + sheet.cellCount, 0) - cells.length
  const completedUnits = cells.filter((cell) => cell.known).length
  for (const cell of cells) for (const code of cell.warnings) warningCodes.add(code)
  if (excludedUnits) warningCodes.add('SELECTION_EXCLUDED')
  if (
    !snapshot.includeHiddenContent &&
    inspection.sheets.some(
      (sheet) => sheet.state !== 'visible' || sheet.hiddenRowCount || sheet.hiddenColumnCount,
    )
  )
    warningCodes.add('HIDDEN_CONTENT_EXCLUDED')
  if (inspection.unsupported.hasMacros || inspection.unsupported.externalLinkCount)
    warningCodes.add('UNSUPPORTED_CONTENT')
  const blocked =
    completedUnits < cells.length ||
    warningCodes.has('UNSUPPORTED_CONTENT') ||
    warningCodes.has('TABLE_INCOMPLETE')
  const source = {
    format: 'xlsx' as const,
    sourceHash: input.sourceHash,
    parserRevision: xlsxParserRevision,
  }
  const coverage = parseKnowledgeCoverage(
    {
      schemaVersion: 1,
      ...source,
      scope: 'selection',
      unit: 'cell',
      status: completedUnits === 0 ? 'failed' : blocked ? 'partial' : 'complete',
      expectedUnits: cells.length,
      completedUnits,
      missingUnits: cells.length - completedUnits,
      excludedUnits,
      warnings: [...warningCodes].map((code) => ({ code, unitOrdinal: null })),
    },
    source,
  )
  return {
    schemaVersion: 1 as const,
    ...source,
    selectionHash: request.snapshotHash,
    selection: snapshot,
    sourceBytes: { unit: 'bytes' as const, value: String(input.bytes.byteLength) },
    text,
    textHash: textHash(text),
    textCodePointLength: xlsxTextLength(text),
    units,
    coverage,
    unsupported: inspection.unsupported,
    preview: text.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    ),
  }
}

export type KnowledgeXlsxDocument = ReturnType<typeof parseKnowledgeXlsxDocument>
