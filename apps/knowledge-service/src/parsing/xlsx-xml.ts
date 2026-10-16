import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { rejectText } from './errors'
import { readZipEntry, zipEntries } from './zip'

export type XlsxXmlNode = Record<string, unknown>
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  alwaysCreateTextNode: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
})

export function scanXlsxXml(
  xml: string,
  onTag: (prefix: string, local: string, attributes: Record<string, string>) => void,
) {
  const walk = (node: XlsxXmlNode, depth: number) => {
    if (depth > 128) rejectText('LIMIT_EXCEEDED')
    for (const [name, value] of Object.entries(node)) {
      if (name.startsWith('@_') || name.startsWith('#') || name.startsWith('?')) continue
      for (const item of Array.isArray(value) ? (value as unknown[]) : [value]) {
        const child = xmlObject(item)
        const attributes: Record<string, string> = {}
        for (const [key, attribute] of Object.entries(child))
          if (key.startsWith('@_')) {
            if (typeof attribute !== 'string') rejectText('CORRUPT_CONTAINER')
            attributes[key.slice(2)] = attribute
          }
        const colon = name.indexOf(':')
        onTag(
          colon < 0 ? '' : name.slice(0, colon),
          colon < 0 ? name : name.slice(colon + 1),
          attributes,
        )
        walk(child, depth + 1)
      }
    }
  }
  walk(parseXlsxXml(new TextEncoder().encode(xml)), 0)
}

export function xmlObject(value: unknown): XlsxXmlNode {
  if (typeof value !== 'object' || !value || Array.isArray(value)) rejectText('CORRUPT_CONTAINER')
  return value as XlsxXmlNode
}

export function xmlChildren(node: XlsxXmlNode, name: string) {
  return Object.entries(node)
    .filter(([key]) => !key.startsWith('@_') && key.split(':').at(-1) === name)
    .flatMap(([, value]) => (Array.isArray(value) ? (value as unknown[]) : [value]))
    .map(xmlObject)
}

export function xmlAttribute(node: XlsxXmlNode, name: string) {
  const value = node[`@_${name}`]
  if (value !== undefined && typeof value !== 'string') rejectText('CORRUPT_CONTAINER')
  return value
}

export function xmlText(node: XlsxXmlNode | undefined) {
  if (!node) return ''
  const value = node['#text']
  if (value === undefined) return ''
  if (typeof value !== 'string') rejectText('CORRUPT_CONTAINER')
  return value
}

export function xmlRichText(node: XlsxXmlNode) {
  return Object.entries(node)
    .flatMap(([name, value]) => {
      const local = name.split(':').at(-1)
      if (local !== 't' && local !== 'r') return []
      return (Array.isArray(value) ? (value as unknown[]) : [value]).map((part) => {
        const child = xmlObject(part)
        return local === 't' ? xmlText(child) : xmlChildren(child, 't').map(xmlText).join('')
      })
    })
    .join('')
}

export function parseXlsxXml(bytes: Uint8Array) {
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    rejectText('INVALID_UTF8')
  }
  // OOXML has no DTD: rejecting declarations prevents external/custom entity expansion.
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true)
    rejectText('CORRUPT_CONTAINER')
  try {
    const result: unknown = parser.parse(xml)
    return xmlObject(result)
  } catch {
    rejectText('CORRUPT_CONTAINER')
  }
}

export function openXlsxPackage(bytes: Uint8Array, maxXmlBytes: number) {
  const entries = zipEntries(bytes)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  if (entries.length > 4096) rejectText('LIMIT_EXCEEDED')
  if (byName.size !== entries.length) rejectText('CORRUPT_CONTAINER')
  let xmlBytes = 0
  for (const entry of entries) {
    if (/\.(xml|rels)$/i.test(entry.name)) xmlBytes += entry.size
    if (xmlBytes > maxXmlBytes) rejectText('LIMIT_EXCEEDED')
  }
  return {
    xml(path: string) {
      const entry = byName.get(path)
      return entry ? parseXlsxXml(readZipEntry(bytes, entry, maxXmlBytes)) : null
    },
  }
}
