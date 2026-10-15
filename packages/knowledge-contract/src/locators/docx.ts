import { integer, literal, nullable, object } from '../validation'
import { headingPath, locatorFields } from './common'

const docxLocator = object({
  ...locatorFields,
  format: literal('docx'),
  headingPath,
  blockIndex: integer(0, 2147483647),
  table: nullable(
    object({
      unit: literal('table_cell'),
      origin: literal(1),
      tableIndex: integer(0, 2147483647),
      row: integer(1, 2147483647),
      column: integer(1, 2147483647),
    }),
  ),
})

export function parseDocxLocator(input: unknown) {
  return docxLocator(input, 'locator')
}
