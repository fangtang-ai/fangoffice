import { readKnowledgeExpansionPacks } from '../shared/knowledge-packages'

export async function fetchKnowledgeExpansionPacks(apiBase: string | undefined, request = fetch) {
  if (!apiBase) throw new Error('Knowledge catalog is not configured')
  const url = new URL('/api/billing/office-packages?product=knowledge_base', apiBase)
  const local =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!local && url.protocol !== 'https:') || url.username || url.password)
    throw new Error('Invalid knowledge catalog URL')
  const response = await request(url, { signal: AbortSignal.timeout(10000), redirect: 'error' })
  if (!response.ok) throw new Error('Knowledge catalog is unavailable')
  const body: unknown = await response.json()
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !('success' in body) ||
    body.success !== true ||
    !('data' in body) ||
    !body.data ||
    typeof body.data !== 'object' ||
    !('packages' in body.data)
  )
    throw new Error('Invalid knowledge catalog response')
  return readKnowledgeExpansionPacks(body.data.packages)
}
