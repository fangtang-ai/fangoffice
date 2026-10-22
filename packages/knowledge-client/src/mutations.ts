import {
  KnowledgeContractError,
  parseKnowledgeDocument,
  parseKnowledgeDocumentInput,
  parseKnowledgeDocumentTarget,
  parseKnowledgeSpace,
  parseKnowledgeSpaceInput,
  parseKnowledgeSpaceTarget,
  parseKnowledgeUploadPreparation,
  parseKnowledgeUploadRequest,
  parseKnowledgeUploadCompletionRequest,
  parseKnowledgeUploadCompletion,
} from '@genoffice/knowledge-contract'
import type { createKnowledgeTransport } from './transport'
import type { KnowledgeRequestOptions } from './types'

export function createKnowledgeMutations(request: ReturnType<typeof createKnowledgeTransport>) {
  return {
    async completeUpload(input: unknown, declaration: unknown, options: KnowledgeRequestOptions = {}) {
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
