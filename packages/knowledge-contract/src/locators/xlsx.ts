import { choice, integer, invalid, literal, object, text } from '../validation.js'
import { locatorFields } from './common.js'

const xlsxLocator = object({
  ...locatorFields,
  format: literal('xlsx'),
  sheetId: text(128),
  sheetName: text(31),
  dateSystem: choice(['1900', '1904']),
  range: object({
    unit: literal('cell'),
    origin: literal(1),
    boundary: literal('inclusive'),
    startRow: integer(1, 1048576),
    endRow: integer(1, 1048576),
    startColumn: integer(1, 16384),
    endColumn: integer(1, 16384),
  }),
  a1: text(32),
})

function columnName(column: number) {
  let remaining = column
  let result = ''
  // A1 columns use one-based base-26 digits: Z is 26, AA is 27.
  while (remaining > 0) {
    remaining -= 1
    result = String.fromCharCode(65 + (remaining % 26)) + result
    remaining = Math.floor(remaining / 26)
  }
  return result
}

export function parseXlsxLocator(input: unknown) {
  const result = xlsxLocator(input, 'locator')
  const { startRow, endRow, startColumn, endColumn } = result.range
  if (startRow > endRow || startColumn > endColumn) invalid('locator.range')
  const first = `${columnName(startColumn)}${startRow}`
  const last = `${columnName(endColumn)}${endRow}`
  if (result.a1 !== (first === last ? first : `${first}:${last}`)) invalid('locator.a1')
  return result
}
