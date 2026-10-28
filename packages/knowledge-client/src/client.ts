import {
  parseKnowledgeDocument,
  parseKnowledgeDocumentTarget,
  parseKnowledgePage,
  parseKnowledgePagination,
  parseKnowledgeSpace,
  parseKnowledgeSpaceTarget,
} from '@genoffice/knowledge-contract'
import { createKnowledgeTransport } from './transport.js'
import { createHistoryReads } from './reads.js'
import { createKnowledgeMutations } from './mutations.js'
import { createKnowledgeUploads } from './uploads.js'
import type {
  KnowledgeAccountAccess,
  KnowledgeClientOptions,
  KnowledgeRequestOptions,
} from './types.js'

export function createKnowledgeClient(
  access: KnowledgeAccountAccess,
  options: KnowledgeClientOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new RangeError('knowledge:invalid-timeout')
  const closed = new AbortController()
  const request = createKnowledgeTransport(access, closed.signal, timeoutMs)
  return {
    close: () => closed.abort(),
    ...createHistoryReads(request),
    ...createKnowledgeMutations(request),
    ...createKnowledgeUploads(request, access, closed.signal, timeoutMs),
    async listDocuments(
      input: unknown,
      pageInput: unknown = {},
      requestOptions: KnowledgeRequestOptions = {},
    ) {
      const target = parseKnowledgeSpaceTarget(input)
      const pagination = parseKnowledgePagination(pageInput)
      const query = new URLSearchParams({ limit: String(pagination.limit) })
      if (pagination.cursor !== null) query.set('cursor', pagination.cursor)
      return request(
        `/spaces/${target.spaceId}/documents?${query}`,
        (value) =>
          parseKnowledgePage(value, (item) => parseKnowledgeDocument(item, target), pagination),
        requestOptions,
      )
    },
    async getDocument(input: unknown, requestOptions: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeDocumentTarget(input)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}`,
        (value) => parseKnowledgeDocument(value, target),
        requestOptions,
      )
    },
    async listSpaces(input: unknown = {}, requestOptions: KnowledgeRequestOptions = {}) {
      const pagination = parseKnowledgePagination(input)
      const query = new URLSearchParams({ limit: String(pagination.limit) })
      if (pagination.cursor !== null) query.set('cursor', pagination.cursor)
      return request(
        `/spaces?${query}`,
        (value) => parseKnowledgePage(value, parseKnowledgeSpace, pagination),
        requestOptions,
      )
    },
  }
}

export type KnowledgeClient = ReturnType<typeof createKnowledgeClient>
