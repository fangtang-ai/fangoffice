import { rejectText } from './errors'
import { xmlAttribute, xmlChildren, xmlRichText, type openXlsxPackage } from './xlsx-xml'

const builtinFormats: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  14: 'mm-dd-yy',
  22: 'm/d/yy h:mm',
  49: '@',
}

export function xlsxTables(archive: ReturnType<typeof openXlsxPackage>) {
  const stringPart = archive.xml('xl/sharedStrings.xml')
  const entries = stringPart
    ? xmlChildren(stringPart, 'sst').flatMap((root) => xmlChildren(root, 'si'))
    : []
  if (entries.length > 200000) rejectText('LIMIT_EXCEEDED')
  const strings = entries.map(xmlRichText)
  const stylePart = archive.xml('xl/styles.xml')
  if (!stylePart) return { strings, formats: ['General'] }
  const root = xmlChildren(stylePart, 'styleSheet')[0]
  if (!root) rejectText('CORRUPT_CONTAINER')
  const custom = new Map<number, string>()
  for (const node of xmlChildren(root, 'numFmts').flatMap((group) =>
    xmlChildren(group, 'numFmt'),
  )) {
    const id = Number(xmlAttribute(node, 'numFmtId'))
    const format = xmlAttribute(node, 'formatCode')
    if (!Number.isSafeInteger(id) || id < 164 || !format || custom.has(id))
      rejectText('CORRUPT_CONTAINER')
    custom.set(id, format)
  }
  const baseStyles = xmlChildren(root, 'cellStyleXfs').flatMap((group) => xmlChildren(group, 'xf'))
  const formats = xmlChildren(root, 'cellXfs')
    .flatMap((group) => xmlChildren(group, 'xf'))
    .map((node) => {
      const baseIndex = xmlAttribute(node, 'xfId')
      if (
        baseIndex !== undefined &&
        (!/^\d+$/.test(baseIndex) || (Number(baseIndex) > 0 && !baseStyles[Number(baseIndex)]))
      )
        rejectText('CORRUPT_CONTAINER')
      const base = baseStyles[Number(baseIndex ?? 0)]
      const inherited = base ? (xmlAttribute(base, 'numFmtId') ?? '0') : '0'
      const apply = xmlAttribute(node, 'applyNumberFormat')
      if (apply !== undefined && !['0', '1', 'true', 'false'].includes(apply))
        rejectText('CORRUPT_CONTAINER')
      const id = Number(
        apply === '0' || apply === 'false'
          ? inherited
          : (xmlAttribute(node, 'numFmtId') ?? inherited),
      )
      if (!Number.isSafeInteger(id) || id < 0) rejectText('CORRUPT_CONTAINER')
      return custom.get(id) ?? builtinFormats[id] ?? `unsupported_builtin_${id}`
    })
  if (formats.length > 65536) rejectText('LIMIT_EXCEEDED')
  return { strings, formats: formats.length ? formats : ['General'] }
}
