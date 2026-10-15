import { integer, invalid, literal, object, record } from '../validation'
import { headingPath, locatorFields } from './common'

const textFields = {
  ...locatorFields,
  headingPath,
  lines: object({
    unit: literal('line'),
    origin: literal(1),
    boundary: literal('inclusive'),
    start: integer(1, 2147483647),
    end: integer(1, 2147483647),
  }),
}
const markdownLocator = object({ ...textFields, format: literal('md') })
const plainTextLocator = object({ ...textFields, format: literal('txt') })

export function parseTextLocator(input: unknown) {
  const source = record(input, 'locator')
  const result =
    source.format === 'md' ? markdownLocator(input, 'locator') : plainTextLocator(input, 'locator')
  if (result.lines.start > result.lines.end) invalid('locator.lines.end')
  return result
}
