import { integer, invalid, literal, nullable, object, type Decoder } from '../validation.js'
import { locatorFields } from './common.js'

const point: Decoder<number> = (input, path) => {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 10000000) {
    invalid(path)
  }
  return input
}
const rotation: Decoder<0 | 90 | 180 | 270> = (input, path) => {
  if (input !== 0 && input !== 90 && input !== 180 && input !== 270) invalid(path)
  return input
}
const geometry = object({
  pageWidth: point,
  pageHeight: point,
  rotation,
  origin: literal('top-left'),
  unit: literal('pt'),
  bbox: nullable(object({ x0: point, y0: point, x1: point, y1: point })),
})
const pdfLocator = object({
  ...locatorFields,
  format: literal('pdf'),
  physicalPage: integer(1, 2147483647),
  blockIndex: integer(0, 2147483647),
  spanIndex: nullable(integer(0, 2147483647)),
  geometry: nullable(geometry),
})

export function parsePdfLocator(input: unknown) {
  const result = pdfLocator(input, 'locator')
  if (result.geometry !== null) {
    const { pageWidth, pageHeight, bbox } = result.geometry
    if (pageWidth === 0 || pageHeight === 0) invalid('locator.geometry')
    // Coordinates are display-page points after rotation, not raw PDF or pixel coordinates.
    if (
      bbox !== null &&
      (bbox.x0 >= bbox.x1 || bbox.y0 >= bbox.y1 || bbox.x1 > pageWidth || bbox.y1 > pageHeight)
    )
      invalid('locator.geometry.bbox')
  }
  return result
}
