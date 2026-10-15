import { rejectText } from './errors'
import { textUnit } from './text-unit'

export function textLines(
  text: string,
  sourceHash: string,
  bomBytes: number,
  limits: { maxCodePoints: number; maxLines: number },
) {
  const units: ReturnType<typeof textUnit>[] = []
  let utf16Offset = 0
  let pointOffset = 0
  let byteOffset = bomBytes
  let utf16Start = 0
  let pointStart = 0
  let byteStart = bomBytes
  const append = () => {
    if (units.length >= limits.maxLines) rejectText('LIMIT_EXCEEDED')
    units.push(
      textUnit(
        text.slice(utf16Start, utf16Offset),
        sourceHash,
        units.length,
        pointStart,
        pointOffset,
        byteStart,
        byteOffset,
      ),
    )
    utf16Start = utf16Offset
    pointStart = pointOffset
    byteStart = byteOffset
  }
  // A single scalar-value pass tracks UTF-16 slicing, UTF-8 source bytes and code points independently.
  for (const point of text) {
    const scalar = point.codePointAt(0)!
    if (
      (scalar < 32 && scalar !== 9 && scalar !== 10 && scalar !== 13) ||
      (scalar >= 127 && scalar <= 159)
    )
      rejectText('BINARY_CONTENT')
    utf16Offset += point.length
    pointOffset += 1
    byteOffset += scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4
    if (pointOffset > limits.maxCodePoints) rejectText('LIMIT_EXCEEDED')
    if (point === '\n' || (point === '\r' && text[utf16Offset] !== '\n')) append()
  }
  if (utf16Start < utf16Offset) append()
  return { units, textCodePointLength: pointOffset }
}
