import {
  parseKnowledgeDocumentTarget,
  parseKnowledgePagination,
  parseKnowledgeSpaceTarget,
} from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { KnowledgePrincipal } from '../identity'
import type { KnowledgeDatabase } from './database'
import { readKnowledgeDocument, readKnowledgeDocuments, readKnowledgeSpaces } from './metadata-read'
import { uploadInput } from './upload-command'

export function knowledgeMetadataReadRoute(url: string | undefined) {
  const match = url?.match(
    /^\/api\/knowledge\/spaces(?:\/([^/?]+)\/documents(?:\/([^/?]+))?)?(?:\?([^#]*))?$/,
  )
  if (!match) return null
  const target = { spaceId: match[1], documentId: match[2] }
  const query = match[3] ?? ''
  if (match[2]) return { kind: 'document' as const, target, query }
  if (match[1]) return { kind: 'documents' as const, target, query }
  return { kind: 'spaces' as const, target, query }
}

export async function handleKnowledgeMetadataRead(
  database: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  route: NonNullable<ReturnType<typeof knowledgeMetadataReadRoute>>,
  now?: () => number,
) {
  if (route.kind === 'document') {
    if (route.query !== '') deny('INVALID_REQUEST')
    const target = uploadInput(parseKnowledgeDocumentTarget, route.target)
    return database.transaction(
      principal,
      (transaction) => readKnowledgeDocument(transaction, target),
      { now },
    )
  }
  const parameters = new URLSearchParams(route.query)
  if (new Set(parameters.keys()).size !== parameters.size) deny('INVALID_REQUEST')
  const pagination = uploadInput(parseKnowledgePagination, Object.fromEntries(parameters))
  if (route.kind === 'spaces') {
    return database.transaction(
      principal,
      (transaction) => readKnowledgeSpaces(transaction, pagination),
      { now },
    )
  }
  const target = uploadInput(parseKnowledgeSpaceTarget, { spaceId: route.target.spaceId })
  return database.transaction(
    principal,
    (transaction) => readKnowledgeDocuments(transaction, target.spaceId, pagination),
    { now },
  )
}
