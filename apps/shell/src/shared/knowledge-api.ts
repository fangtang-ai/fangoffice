import type { KnowledgeClient, KnowledgeClientError } from '@genoffice/knowledge-client'

export type KnowledgeFailureCode =
  KnowledgeClientError['code'] | NonNullable<KnowledgeClientError['problem']>['code']
export type KnowledgeResult<Value> =
  { ok: true; value: Value } | { ok: false; code: KnowledgeFailureCode }
export type KnowledgePageInput = { cursor?: string; limit?: number }
export type KnowledgeSpaces = Awaited<ReturnType<KnowledgeClient['listSpaces']>>
export type KnowledgeDocuments = Awaited<ReturnType<KnowledgeClient['listDocuments']>>
export type KnowledgeDocument = Awaited<ReturnType<KnowledgeClient['getDocument']>>
export type KnowledgeDocumentDeletion = Awaited<ReturnType<KnowledgeClient['deleteDocument']>>
export type KnowledgeOperation = Awaited<ReturnType<KnowledgeClient['getOperation']>>
export type KnowledgeQuota = Awaited<ReturnType<KnowledgeClient['getQuota']>>
export type KnowledgeDocumentTarget = { spaceId: string; documentId: string }
export type KnowledgeOperationTarget = KnowledgeDocumentTarget & { operationId: string }
export type KnowledgeSearch = Awaited<ReturnType<KnowledgeClient['search']>>
export type KnowledgeSearchHit = KnowledgeSearch['hits'][number]
export type KnowledgeSearchRequest = { spaceId: string; query: string; limit?: number }
export type KnowledgeSourceUnit = Awaited<ReturnType<KnowledgeClient['getSourceUnit']>>
export type KnowledgeSourceUnitTarget = {
  spaceId: string
  documentId: string
  versionId: string
  buildId: string
  sourceUnitId: string
}

export interface KnowledgeApi {
  listSpaces(page?: KnowledgePageInput): Promise<KnowledgeResult<KnowledgeSpaces>>
  createSpace(title: string): Promise<KnowledgeResult<KnowledgeSpaces['items'][number]>>
  listDocuments(
    spaceId: string,
    page?: KnowledgePageInput,
  ): Promise<KnowledgeResult<KnowledgeDocuments>>
  getDocument(target: KnowledgeDocumentTarget): Promise<KnowledgeResult<KnowledgeDocument>>
  deleteDocument(
    target: KnowledgeDocumentTarget,
  ): Promise<KnowledgeResult<KnowledgeDocumentDeletion | null>>
  getOperation(target: KnowledgeOperationTarget): Promise<KnowledgeResult<KnowledgeOperation>>
  getQuota(): Promise<KnowledgeResult<KnowledgeQuota>>
  search(request: KnowledgeSearchRequest): Promise<KnowledgeResult<KnowledgeSearch>>
  getSourceUnit(target: KnowledgeSourceUnitTarget): Promise<KnowledgeResult<KnowledgeSourceUnit>>
  uploadText(spaceId: string): Promise<
    KnowledgeResult<{
      document: KnowledgeDocument
      operation: KnowledgeOperation
    } | null>
  >
}

export const KNOWLEDGE_CHANNELS = {
  listSpaces: 'knowledge:list-spaces',
  createSpace: 'knowledge:create-space',
  listDocuments: 'knowledge:list-documents',
  getDocument: 'knowledge:get-document',
  deleteDocument: 'knowledge:delete-document',
  getOperation: 'knowledge:get-operation',
  getQuota: 'knowledge:get-quota',
  search: 'knowledge:search',
  getSourceUnit: 'knowledge:get-source-unit',
  uploadText: 'knowledge:upload-text',
} as const
