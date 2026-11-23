import {
  KnowledgeContractError,
  parseKnowledgeSearchRequest,
  parseKnowledgeSearchResult,
  parseKnowledgeDocument,
  parseKnowledgeDocumentInput,
  parseKnowledgeDocumentTarget,
  parseKnowledgeDocumentDeletionRequest,
  parseKnowledgeDocumentDeletion,
  parseKnowledgeSpace,
  parseKnowledgeSpaceInput,
  parseKnowledgeSpaceTarget,
  parseKnowledgeUploadPreparation,
  parseKnowledgeUploadRequest,
  parseKnowledgeUploadCompletionRequest,
  parseKnowledgeUploadCompletion,
} from '@genoffice/knowledge-contract'
import type { createKnowledgeTransport } from './transport.js'
import type { KnowledgeRequestOptions } from './types.js'

export function createKnowledgeMutations(request: ReturnType<typeof createKnowledgeTransport>) {
  return {
    async deleteDocument(input: unknown, identity: unknown, options: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeDocumentTarget(input)
      const declaration = parseKnowledgeDocumentDeletionRequest(identity)
      return request(
        '/deletions',
        (value) => parseKnowledgeDocumentDeletion(value, declaration),
        options,
        {
          method: 'DELETE',
          body: { id: declaration.intentId, scope: { kind: 'document', ...target } },
        },
      )
    },
    async search(input: unknown, options: KnowledgeRequestOptions = {}) {
      const body = parseKnowledgeSearchRequest(input)
      return request('/search', (value) => parseKnowledgeSearchResult(value, body), options, {
        method: 'POST',
        body,
      })
    },
    async completeUpload(
      input: unknown,
      declaration: unknown,
      options: KnowledgeRequestOptions = {},
    ) {
      const target = parseKnowledgeDocumentTarget(input)
      const body = parseKnowledgeUploadCompletionRequest(declaration)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}/uploads/completion`,
        (value) => parseKnowledgeUploadCompletion(value, target, body),
        options,
        { method: 'POST', body },
      )
    },
    async createSpace(input: unknown, metadata: unknown, options: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeSpaceTarget(input)
      const body = parseKnowledgeSpaceInput(metadata)
      return request(
        `/spaces/${target.spaceId}`,
        (value) => {
          const result = parseKnowledgeSpace(value)
          if (result.id !== target.spaceId) throw new KnowledgeContractError('space.id')
          return result
        },
        options,
        { method: 'PUT', body },
      )
    },
    async createDocument(input: unknown, metadata: unknown, options: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeDocumentTarget(input)
      const body = parseKnowledgeDocumentInput(metadata)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}`,
        (value) => parseKnowledgeDocument(value, target),
        options,
        { method: 'PUT', body },
      )
    },
    async prepareUpload(
      input: unknown,
      declaration: unknown,
      options: KnowledgeRequestOptions = {},
    ) {
      const target = parseKnowledgeDocumentTarget(input)
      const body = parseKnowledgeUploadRequest(declaration)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}/uploads`,
        (value) => parseKnowledgeUploadPreparation(value, target, body),
        options,
        { method: 'POST', body },
      )
    },
  }
}
