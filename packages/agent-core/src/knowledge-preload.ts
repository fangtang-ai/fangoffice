import {
  KNOWLEDGE_CHAT_CHANNELS,
  type KnowledgeChatApi,
  type KnowledgeChatReply,
} from './knowledge-api'

type KnowledgeIpc = {
  invoke(channel: string, ...input: unknown[]): Promise<unknown>
  on(channel: string, listener: () => void): unknown
  removeListener(channel: string, listener: () => void): unknown
}

export function createKnowledgeChatApi(ipc: KnowledgeIpc) {
  const invoke = async <Value>(
    channel: string,
    ...input: unknown[]
  ): Promise<KnowledgeChatReply<Value>> => {
    try {
      return (await ipc.invoke(channel, ...input)) as KnowledgeChatReply<Value>
    } catch {
      return { ok: false, code: 'knowledge:not-configured' }
    }
  }
  const api: KnowledgeChatApi = {
    session: () => invoke(KNOWLEDGE_CHAT_CHANNELS.session),
    listSpaces: (sessionId, page) => invoke(KNOWLEDGE_CHAT_CHANNELS.listSpaces, sessionId, page),
    listDocuments: (sessionId, spaceId, page) =>
      invoke(KNOWLEDGE_CHAT_CHANNELS.listDocuments, sessionId, spaceId, page),
    getOperation: (sessionId, target) =>
      invoke(KNOWLEDGE_CHAT_CHANNELS.getOperation, sessionId, target),
    search: (sessionId, request) => invoke(KNOWLEDGE_CHAT_CHANNELS.search, sessionId, request),
    getSourceUnit: (sessionId, target) =>
      invoke(KNOWLEDGE_CHAT_CHANNELS.getSourceUnit, sessionId, target),
    onSessionChanged: (listener) => {
      ipc.on(KNOWLEDGE_CHAT_CHANNELS.sessionChanged, listener)
      return () => {
        ipc.removeListener(KNOWLEDGE_CHAT_CHANNELS.sessionChanged, listener)
      }
    },
  }
  return api
}
