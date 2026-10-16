import { rejectText } from './errors'
import { isDeepStrictEqual } from 'node:util'
import { xlsxDocumentRequest } from './request'
import { textHash } from './text-unit'
import { freezeKnowledgeXlsxSelection, inspectKnowledgeXlsxWorkbook } from './xlsx-inspect'

export function xlsxDocumentSelection(request: ReturnType<typeof xlsxDocumentRequest>) {
  const { input, snapshot, snapshotHash, limits } = request
  if (
    typeof snapshot !== 'object' ||
    !snapshot ||
    !('sheets' in snapshot) ||
    !('includeHiddenContent' in snapshot) ||
    !Array.isArray(snapshot.sheets)
  )
    rejectText('INVALID_REQUEST')
  let serialized: string
  try {
    serialized = JSON.stringify(snapshot)
  } catch {
    rejectText('INVALID_REQUEST')
  }
  if (textHash(serialized) !== snapshotHash) rejectText('SOURCE_MISMATCH')
  const inspection = inspectKnowledgeXlsxWorkbook(input, {
    maxBytes: limits.maxBytes,
    maxXmlBytes: limits.maxXmlBytes,
    maxSheets: 512,
  })
  const sheets = (snapshot.sheets as unknown[]).map((item) => {
    if (
      typeof item !== 'object' ||
      !item ||
      !('sheetId' in item) ||
      !('range' in item) ||
      typeof item.sheetId !== 'string' ||
      !/^[1-9]\d*$/.test(item.sheetId)
    )
      rejectText('INVALID_REQUEST')
    return { sheetId: Number(item.sheetId), ...(item.range === null ? {} : { range: item.range }) }
  })
  const frozen = freezeKnowledgeXlsxSelection(
    inspection,
    {
      sourceHash: input.sourceHash,
      selection: { includeHiddenContent: snapshot.includeHiddenContent, sheets },
    },
    { maxSelectedSheets: limits.maxSheets, maxSelectedCells: 2000000 },
  )
  // Rebuild trusted names, date system and ranges from the actual source, not caller metadata.
  if (!isDeepStrictEqual(frozen.snapshot, snapshot)) rejectText('SOURCE_MISMATCH')
  return { inspection, snapshot: snapshot as typeof frozen.snapshot }
}
