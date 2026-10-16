import { rejectText } from './errors'
import { xlsxA1, xlsxIntersects, xlsxRangeRef, type XlsxRange } from './xlsx-grid'
import { xmlAttribute, xmlChildren, type XlsxXmlNode } from './xlsx-xml'

export function xlsxMerges(
  worksheet: XlsxXmlNode,
  selection: XlsxRange | null,
  visibleCells: ReadonlySet<string>,
) {
  const nodes = xmlChildren(worksheet, 'mergeCells').flatMap((group) =>
    xmlChildren(group, 'mergeCell'),
  )
  if (nodes.length > 1024) rejectText('LIMIT_EXCEEDED')
  const ranges = nodes.map((node) => {
    const ref = xmlAttribute(node, 'ref')
    if (!ref) rejectText('CORRUPT_CONTAINER')
    return xlsxRangeRef(ref)
  })
  // ponytail: pairwise overlap checks are capped at 1024 merges; no unbounded quadratic scan.
  for (let index = 0; index < ranges.length; index += 1)
    if (ranges.slice(0, index).some((other) => xlsxIntersects(other, ranges[index]!)))
      rejectText('CORRUPT_CONTAINER')
  return ranges
    .filter((range) => selection && xlsxIntersects(range, selection))
    .map((range) => {
      const anchor = xlsxA1({ ...range, endRow: range.startRow, endColumn: range.startColumn })
      return { ...range, a1: xlsxA1(range), anchor, anchorAvailable: visibleCells.has(anchor) }
    })
}
