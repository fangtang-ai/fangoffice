import { rejectText } from './errors'

export type XlsxRange = { startRow: number; endRow: number; startColumn: number; endColumn: number }

export function xlsxCellRef(ref: string) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref)
  if (!match) rejectText('CORRUPT_CONTAINER')
  let column = 0
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64
  const row = Number(match[2])
  if (row > 1048576 || column > 16384) rejectText('CORRUPT_CONTAINER')
  return { row, column }
}

export function xlsxColumn(column: number) {
  let remaining = column
  let result = ''
  while (remaining > 0) {
    remaining -= 1
    result = String.fromCharCode(65 + (remaining % 26)) + result
    remaining = Math.floor(remaining / 26)
  }
  return result
}

export function xlsxRangeRef(ref: string) {
  const parts = ref.split(':')
  if (parts.length > 2) rejectText('CORRUPT_CONTAINER')
  const first = xlsxCellRef(parts[0]!)
  const last = xlsxCellRef(parts[1] ?? parts[0]!)
  if (first.row > last.row || first.column > last.column) rejectText('CORRUPT_CONTAINER')
  return {
    startRow: first.row,
    endRow: last.row,
    startColumn: first.column,
    endColumn: last.column,
  }
}

export function xlsxContains(range: XlsxRange | null, row: number, column: number) {
  return (
    !!range &&
    row >= range.startRow &&
    row <= range.endRow &&
    column >= range.startColumn &&
    column <= range.endColumn
  )
}

export function xlsxIntersects(left: XlsxRange, right: XlsxRange) {
  return (
    left.startRow <= right.endRow &&
    right.startRow <= left.endRow &&
    left.startColumn <= right.endColumn &&
    right.startColumn <= left.endColumn
  )
}

export function xlsxA1(range: XlsxRange) {
  const first = `${xlsxColumn(range.startColumn)}${range.startRow}`
  const last = `${xlsxColumn(range.endColumn)}${range.endRow}`
  return first === last ? first : `${first}:${last}`
}
