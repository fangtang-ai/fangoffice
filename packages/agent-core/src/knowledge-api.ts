import type {
  KnowledgeDocument,
  KnowledgeErrorCode,
  KnowledgeOperation,
  KnowledgePage,
  KnowledgeSearchResult,
  KnowledgeSourceUnit,
  KnowledgeSpace,
} from '@genoffice/knowledge-contract'

export type KnowledgeChatSession = { userId: string; sessionId: number }
export type KnowledgeChatPage = { cursor?: string; limit?: number }
export type KnowledgeChatReply<Value> =
  { ok: true; value: Value } | { ok: false; code: KnowledgeErrorCode | `knowledge:${string}` }
export type KnowledgeChatDocumentTarget = { spaceId: string; documentId: string }
export type KnowledgeChatSourceTarget = KnowledgeChatDocumentTarget & {
  versionId: string
  buildId: string
  sourceUnitId: string
}

export interface KnowledgeChatApi {
  session(): Promise<KnowledgeChatReply<KnowledgeChatSession>>
  listSpaces(
    sessionId: number,
    page?: KnowledgeChatPage,
  ): Promise<KnowledgeChatReply<KnowledgePage<KnowledgeSpace>>>
  listDocuments(
    sessionId: number,
    spaceId: string,
    page?: KnowledgeChatPage,
  ): Promise<KnowledgeChatReply<KnowledgePage<KnowledgeDocument>>>
  getOperation(
    sessionId: number,
    target: KnowledgeChatDocumentTarget & { operationId: string },
  ): Promise<KnowledgeChatReply<KnowledgeOperation>>
  search(sessionId: number, request: unknown): Promise<KnowledgeChatReply<KnowledgeSearchResult>>
  getSourceUnit(
    sessionId: number,
    target: KnowledgeChatSourceTarget,
  ): Promise<KnowledgeChatReply<KnowledgeSourceUnit>>
  onSessionChanged(listener: () => void): () => void
}

export const KNOWLEDGE_CHAT_CHANNELS = {
  session: 'knowledge:chat:session',
  sessionChanged: 'knowledge:chat:session-changed',
  listSpaces: 'knowledge:chat:list-spaces',
  listDocuments: 'knowledge:chat:list-documents',
  getOperation: 'knowledge:chat:get-operation',
  search: 'knowledge:chat:search',
  getSourceUnit: 'knowledge:chat:get-source-unit',
} as const
