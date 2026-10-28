import { parseKnowledgeScope } from './requests.js'
import {
  contentUuid,
  defaulted,
  integer,
  invalid,
  list,
  literal,
  object,
  sha256,
  text,
  unique,
  uuid,
} from './validation.js'

function scalarText(input: unknown, path: string, maximum: number) {
  if (typeof input !== 'string' || !input || input.length > maximum * 2) invalid(path)
  const value = input
  let length = 0
  for (const point of value) {
    const scalar = point.codePointAt(0)!
    if (scalar >= 0xd800 && scalar <= 0xdfff) invalid(path)
    length += 1
  }
  if (length > maximum || value.includes('\0')) invalid(path)
  return value
}

const searchRequest = object({
  scope: parseKnowledgeScope,
  query: (input, path) => scalarText(text(2048)(input, path), path, 1024),
  limit: defaulted(integer(1, 20), 10),
})

export function parseKnowledgeSearchRequest(input: unknown) {
  return searchRequest(input, 'searchRequest')
}

const searchHit = object({
  spaceId: uuid,
  documentId: uuid,
  versionId: uuid,
  buildId: uuid,
  chunkId: contentUuid,
  title: text(200),
  chunkTextHash: sha256,
  distance: (input, path) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 2)
      invalid(path)
    return input
  },
  snippet: object({
    text: (input, path) => scalarText(input, path, 1000),
    startCp: literal(0),
    endCp: integer(1, 1000),
    chunkCodePointLength: integer(1, 4 * 1024 * 1024),
  }),
  sources: list(
    object({
      sourceUnitId: contentUuid,
      startCp: integer(0, 4 * 1024 * 1024),
      endCp: integer(1, 4 * 1024 * 1024),
    }),
    1,
    1000,
  ),
})
const searchResult = object({
  runId: uuid,
  callId: uuid,
  attemptId: uuid,
  indexProfileId: uuid,
  hits: list(searchHit, 0, 20),
})

export function parseKnowledgeSearchResult(input: unknown, requestInput: unknown) {
  const request = parseKnowledgeSearchRequest(requestInput)
  const result = searchResult(input, 'searchResult')
  if (result.hits.length > request.limit) invalid('searchResult.hits')
  unique(
    result.hits,
    (hit) => `${hit.spaceId}/${hit.documentId}/${hit.versionId}/${hit.buildId}/${hit.chunkId}`,
    'searchResult.hits',
  )
  let previousDistance = -1
  for (const hit of result.hits) {
    const inScope =
      request.scope.kind === 'spaces'
        ? request.scope.spaceIds.includes(hit.spaceId)
        : request.scope.documents.some(
            (target) => target.spaceId === hit.spaceId && target.documentId === hit.documentId,
          )
    if (!inScope || hit.distance < previousDistance) invalid('searchResult.hits')
    previousDistance = hit.distance
    const snippet = hit.snippet
    if ([...snippet.text].length !== snippet.endCp || snippet.endCp > snippet.chunkCodePointLength)
      invalid('searchResult.hits.snippet')
    let previousEnd = 0
    for (const source of hit.sources) {
      if (
        source.startCp !== previousEnd ||
        source.endCp <= source.startCp ||
        source.startCp >= snippet.endCp ||
        source.endCp > snippet.chunkCodePointLength
      )
        invalid('searchResult.hits.sources')
      previousEnd = source.endCp
    }
    if (previousEnd < snippet.endCp) invalid('searchResult.hits.sources')
  }
  return result
}

export type KnowledgeSearchRequest = ReturnType<typeof parseKnowledgeSearchRequest>
export type KnowledgeSearchResult = ReturnType<typeof parseKnowledgeSearchResult>
export type KnowledgeSearchHit = KnowledgeSearchResult['hits'][number]
