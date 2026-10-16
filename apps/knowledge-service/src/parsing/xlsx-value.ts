import type { KnowledgeParseWarningCode } from '@genoffice/knowledge-contract'
import { rejectText } from './errors'
import { formatXlsxNumber } from './xlsx-number'
import { xlsxString, xlsxIsoDate } from './xlsx-string'
import type { xlsxTables } from './xlsx-styles'
import { xmlAttribute, xmlChildren, xmlRichText, xmlText, type XlsxXmlNode } from './xlsx-xml'

export function xlsxCellValue(
  node: XlsxXmlNode,
  tables: ReturnType<typeof xlsxTables>,
  dateSystem: '1900' | '1904',
  inheritedStyle = '0',
) {
  const inline = xmlChildren(node, 'is')[0]
  const values = xmlChildren(node, 'v')
  const formulas = xmlChildren(node, 'f')
  if (values.length > 1 || formulas.length > 1 || (inline && values.length))
    rejectText('CORRUPT_CONTAINER')
  const raw = inline ? xmlRichText(inline) : values[0] ? xmlText(values[0]) : null
  const sourceType = xmlAttribute(node, 't') ?? 'n'
  const styleIndex = xmlAttribute(node, 's') ?? inheritedStyle
  if (!/^\d+$/.test(styleIndex)) rejectText('CORRUPT_CONTAINER')
  const numberFormat = tables.formats[Number(styleIndex)]
  if (numberFormat === undefined) rejectText('CORRUPT_CONTAINER')
  const formula = formulas[0]
    ? {
        text: xmlText(formulas[0]) || null,
        type: xmlAttribute(formulas[0], 't') ?? 'normal',
        cache:
          raw !== null && (raw !== '' || sourceType === 'str')
            ? ('present' as const)
            : ('missing' as const),
        freshness: 'unknown' as const,
      }
    : null
  const warnings: KnowledgeParseWarningCode[] = []
  if (formula)
    warnings.push(formula.cache === 'present' ? 'FORMULA_CACHE_STALE' : 'FORMULA_CACHE_MISSING')
  const base = { raw, numberFormat, formula, warnings }
  if (
    (formula && formula.cache === 'missing') ||
    raw === null ||
    (raw === '' && sourceType === 'n')
  )
    return {
      ...base,
      value: null,
      display: null,
      type: 'blank' as const,
      displayKind: 'raw' as const,
      known: !formula,
    }
  if (sourceType === 's') {
    if (!/^\d+$/.test(raw) || tables.strings[Number(raw)] === undefined)
      rejectText('CORRUPT_CONTAINER')
    const value = xlsxString(tables.strings[Number(raw)]!)
    return {
      ...base,
      value,
      display: value,
      type: 'text' as const,
      displayKind: 'raw' as const,
      known: true,
    }
  }
  if (sourceType === 'inlineStr' || sourceType === 'str') {
    const value = xlsxString(raw)
    return {
      ...base,
      value,
      display: value,
      type: 'text' as const,
      displayKind: 'raw' as const,
      known: true,
    }
  }
  if (sourceType === 'd') {
    const value = xlsxIsoDate(raw)
    return {
      ...base,
      value,
      display: value,
      type: 'date' as const,
      displayKind: 'raw' as const,
      known: true,
    }
  }
  if (sourceType === 'b') {
    if (raw !== '0' && raw !== '1') rejectText('CORRUPT_CONTAINER')
    return {
      ...base,
      value: raw === '1' ? 'true' : 'false',
      display: raw === '1' ? 'TRUE' : 'FALSE',
      type: 'boolean' as const,
      displayKind: 'raw' as const,
      known: true,
    }
  }
  if (sourceType === 'e') {
    warnings.push('UNSUPPORTED_CONTENT')
    return {
      ...base,
      value: raw,
      display: raw,
      type: 'error' as const,
      displayKind: 'raw' as const,
      known: false,
    }
  }
  if (sourceType !== 'n') rejectText('CORRUPT_CONTAINER')
  const formatted = formatXlsxNumber(raw, numberFormat, dateSystem)
  if (formatted.displayKind === 'unsupported') warnings.push('UNSUPPORTED_NUMBER_FORMAT')
  if (!formatted.known) warnings.push('UNSUPPORTED_CONTENT')
  return { ...base, value: raw, ...formatted }
}

export function xlsxCellText(cell: ReturnType<typeof xlsxCellValue>) {
  if (!cell.known) return '[unknown]'
  if (cell.display !== null) return cell.display || '[empty]'
  if (cell.value !== null) return `${cell.value} [raw; unsupported format]`
  return '[blank]'
}
