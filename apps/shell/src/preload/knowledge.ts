import { ipcRenderer } from 'electron'
import {
  KNOWLEDGE_CHANNELS,
  type KnowledgeApi,
  type KnowledgeResult,
} from '../shared/knowledge-api'

function invokeKnowledge<Value>(channel: string, ...input: unknown[]) {
  return ipcRenderer.invoke(channel, ...input) as Promise<KnowledgeResult<Value>>
}

export const knowledgeApi: KnowledgeApi = {
  listSpaces: (page) => invokeKnowledge(KNOWLEDGE_CHANNELS.listSpaces, page),
  createSpace: (title) => invokeKnowledge(KNOWLEDGE_CHANNELS.createSpace, title),
  listDocuments: (spaceId, page) =>
    invokeKnowledge(KNOWLEDGE_CHANNELS.listDocuments, spaceId, page),
  getDocument: (target) => invokeKnowledge(KNOWLEDGE_CHANNELS.getDocument, target),
  deleteDocument: (target) => invokeKnowledge(KNOWLEDGE_CHANNELS.deleteDocument, target),
  getOperation: (target) => invokeKnowledge(KNOWLEDGE_CHANNELS.getOperation, target),
  getQuota: () => invokeKnowledge(KNOWLEDGE_CHANNELS.getQuota),
  search: (request) => invokeKnowledge(KNOWLEDGE_CHANNELS.search, request),
  getSourceUnit: (target) => invokeKnowledge(KNOWLEDGE_CHANNELS.getSourceUnit, target),
  uploadText: (spaceId) => invokeKnowledge(KNOWLEDGE_CHANNELS.uploadText, spaceId),
}
