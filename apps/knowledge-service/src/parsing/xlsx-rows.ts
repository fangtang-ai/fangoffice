import type { KnowledgeParseWarningCode } from '@genoffice/knowledge-contract'
import { rejectText } from './errors'
import { xlsxCellRef, xlsxContains } from './xlsx-grid'
import type { KnowledgeXlsxSelectionSnapshot } from './xlsx-inspect'
import { xlsxTextLength, type createXlsxLocator } from './xlsx-locator'
import { xlsxMerges } from './xlsx-merges'
import type { xlsxDocumentRequest } from './request'
import { textHash } from './text-unit'
import type { xlsxTables } from './xlsx-styles'
import { xlsxCellText, xlsxCellValue } from './xlsx-value'
import { xmlAttribute, xmlChildren, type XlsxXmlNode } from './xlsx-xml'

interface RowContext {
  limits: ReturnType<typeof xlsxDocumentRequest>['limits']
  tables: ReturnType<typeof xlsxTables>
  dateSystem: '1900' | '1904'
  includeHiddenContent: boolean
  locator: ReturnType<typeof createXlsxLocator>
  budget: { cells: number; points: number }
}

function hidden(node: XlsxXmlNode) {
  const value = xmlAttribute(node, 'hidden') ?? '0'
  if (!['0', '1', 'true', 'false'].includes(value)) rejectText('CORRUPT_CONTAINER')
  return value === '1' || value === 'true'
}

function physicalRows(worksheet: XlsxXmlNode) {
  const groups = xmlChildren(worksheet, 'sheetData')
  if (groups.length !== 1) rejectText('CORRUPT_CONTAINER')
  let lastRow = 0
  return xmlChildren(groups[0]!, 'row').map((node) => {
    const cells = xmlChildren(node, 'c').map((cell) => {
      const a1 = xmlAttribute(cell, 'r')
      if (!a1) rejectText('CORRUPT_CONTAINER')
      return { node: cell, a1, ...xlsxCellRef(a1) }
    })
    const row = Number(xmlAttribute(node, 'r') ?? cells[0]?.row ?? lastRow + 1)
    if (!Number.isSafeInteger(row) || row <= lastRow || row > 1048576)
      rejectText('CORRUPT_CONTAINER')
    lastRow = row
    const seen = new Set<number>()
    for (const cell of cells) {
      if (cell.row !== row || seen.has(cell.column)) rejectText('CORRUPT_CONTAINER')
      seen.add(cell.column)
    }
    return {
      row,
      hidden: hidden(node),
      style: ['1', 'true'].includes(xmlAttribute(node, 'customFormat') ?? '')
        ? xmlAttribute(node, 's')
        : undefined,
      cells: cells.sort((left, right) => left.column - right.column),
    }
  })
}

export function xlsxRows(
  worksheet: XlsxXmlNode,
  sheet: KnowledgeXlsxSelectionSnapshot['sheets'][number],
  context: RowContext,
) {
  const { limits, budget, locator } = context
  const physical = physicalRows(worksheet)
  const columnRanges = xmlChildren(worksheet, 'cols')
    .flatMap((group) => xmlChildren(group, 'col'))
    .map((node) => {
      const start = Number(xmlAttribute(node, 'min'))
      const end = Number(xmlAttribute(node, 'max'))
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start ||
        end > 16384
      )
        rejectText('CORRUPT_CONTAINER')
      return { start, end, hidden: hidden(node), style: xmlAttribute(node, 'style') }
    })
  const columnCache = new Map<number, { hidden: boolean; style: string | undefined }>()
  const columnProfile = (column: number) => {
    const cached = columnCache.get(column)
    if (cached) return cached
    const profile = { hidden: false, style: undefined as string | undefined }
    // Cache only encountered physical columns; do not expand a sparse sheet into an empty grid.
    for (const range of columnRanges) {
      if (column < range.start || column > range.end) continue
      profile.hidden ||= range.hidden
      if (range.style !== undefined) profile.style = range.style
    }
    columnCache.set(column, profile)
    return profile
  }
  const selected = physical
    .filter((row) => context.includeHiddenContent || !row.hidden)
    .map((row) => ({
      row: row.row,
      style: row.style,
      cells: row.cells.filter(
        (cell) =>
          xlsxContains(sheet.range, cell.row, cell.column) &&
          (context.includeHiddenContent || !columnProfile(cell.column).hidden),
      ),
    }))
  const visibleCells = new Set(selected.flatMap((row) => row.cells.map((cell) => cell.a1)))
  const merges = xlsxMerges(worksheet, sheet.range, visibleCells)
  const columns = new Set<number>()
  const rows = selected.flatMap((row) => {
    const cells = row.cells.flatMap((physicalCell) => {
      const { node, a1, column } = physicalCell
      const value = xlsxCellValue(
        node,
        context.tables,
        context.dateSystem,
        row.style ?? columnProfile(column).style ?? '0',
      )
      const merge = merges.find((range) => xlsxContains(range, row.row, column)) ?? null
      if (merge && a1 !== merge.anchor) {
        if (value.raw !== null && value.raw !== '') rejectText('CORRUPT_CONTAINER')
        if (merge.anchorAvailable) return []
        value.known = false
        value.warnings.push('TABLE_INCOMPLETE')
      }
      columns.add(column)
      budget.cells += 1
      if (budget.cells > limits.maxCells || columns.size > limits.maxColumnsPerSheet)
        rejectText('LIMIT_EXCEEDED')
      return [
        {
          ...value,
          row: row.row,
          column,
          a1,
          merge,
          locator: locator(xlsxCellText(value), sheet, {
            startRow: row.row,
            endRow: row.row,
            startColumn: column,
            endColumn: column,
          }),
        },
      ]
    })
    if (!cells.length) return []
    const text = cells.map((cell) => `${cell.a1}=${xlsxCellText(cell)}`).join(' | ')
    budget.points += xlsxTextLength(text) + 1
    if (budget.points - 1 > limits.maxCodePoints) rejectText('LIMIT_EXCEEDED')
    const range = {
      startRow: row.row,
      endRow: row.row,
      startColumn: cells[0]!.column,
      endColumn: cells.at(-1)!.column,
    }
    return [
      {
        sheetId: sheet.sheetId,
        sheetName: sheet.name,
        row: row.row,
        cells,
        text,
        textHash: textHash(text),
        locator: locator(text, sheet, range),
        merges,
      },
    ]
  })
  if (rows.length > limits.maxRowsPerSheet) rejectText('LIMIT_EXCEEDED')
  const warnings: KnowledgeParseWarningCode[] = []
  if (
    ['drawing', 'legacyDrawing', 'pivotTableParts', 'extLst'].some(
      (tag) => xmlChildren(worksheet, tag).length,
    )
  )
    warnings.push('UNSUPPORTED_CONTENT')
  const headers = rows[0]?.cells ?? []
  return {
    rows: rows.map((row) => ({ ...row, headers, headerSource: 'first_selected_row' as const })),
    warnings,
  }
}
