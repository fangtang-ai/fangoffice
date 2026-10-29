import { KNOWLEDGE_CHAT_CHANNELS, type KnowledgeChatReply } from '@genoffice/agent-core'
import {
  createKnowledgeClient,
  KnowledgeClientError,
  type KnowledgeClient,
} from '@genoffice/knowledge-client'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { getAccountKnowledgeAccess, onAccountSessionInvalidated } from './auth'

export function registerKnowledgeChatIpc(getEditors: () => readonly WebContents[]) {
  onAccountSessionInvalidated(() => {
    for (const editor of getEditors()) {
      if (!editor.isDestroyed()) editor.send(KNOWLEDGE_CHAT_CHANNELS.sessionChanged)
    }
  })
  const trusted = (event: IpcMainInvokeEvent) =>
    !event.sender.isDestroyed() &&
    event.senderFrame === event.sender.mainFrame &&
    getEditors().includes(event.sender)
  const register = <Value>(
    channel: string,
    work: (client: KnowledgeClient, ...input: unknown[]) => Promise<Value>,
  ) => {
    ipcMain.handle(
      channel,
      async (
        event: IpcMainInvokeEvent,
        sessionId: unknown,
        ...input: unknown[]
      ): Promise<KnowledgeChatReply<Value>> => {
        if (!trusted(event)) return { ok: false, code: 'FORBIDDEN' }
        let client: KnowledgeClient | undefined
        try {
          const access = getAccountKnowledgeAccess()
          const binding = access.bind()
          if (sessionId !== binding.sessionId)
            return { ok: false, code: 'knowledge:account-changed' }
          // Each tool stays pinned to the original account and owned main frame, including late network replies.
          const check = () => {
            if (!trusted(event) || binding.signal.aborted || !access.isCurrent(binding))
              throw new KnowledgeClientError('knowledge:account-changed')
          }
          check()
          client = createKnowledgeClient(
            {
              ...access,
              bind: () => {
                check()
                return binding
              },
            },
            { timeoutMs: 120000 },
          )
          const value = await work(client, ...input)
          check()
          return { ok: true, value }
        } catch (error) {
          if (error instanceof KnowledgeClientError)
            return { ok: false, code: error.problem?.code ?? error.code }
          if (error instanceof Error && /^account:/.test(error.message))
            return { ok: false, code: 'knowledge:account-required' }
          if (error instanceof Error && error.name === 'KnowledgeContractError')
            return { ok: false, code: 'INVALID_REQUEST' }
          return { ok: false, code: 'knowledge:request-failed' }
        } finally {
          client?.close()
        }
      },
    )
  }
  ipcMain.handle(KNOWLEDGE_CHAT_CHANNELS.session, async (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) return { ok: false, code: 'FORBIDDEN' }
    try {
      const binding = getAccountKnowledgeAccess().bind()
      return { ok: true, value: { userId: binding.userId, sessionId: binding.sessionId } }
    } catch {
      return { ok: false, code: 'knowledge:account-required' }
    }
  })
  register(KNOWLEDGE_CHAT_CHANNELS.listSpaces, (client, page) => client.listSpaces(page ?? {}))
  register(KNOWLEDGE_CHAT_CHANNELS.listDocuments, (client, spaceId, page) =>
    client.listDocuments({ spaceId }, page ?? {}),
  )
  register(KNOWLEDGE_CHAT_CHANNELS.getOperation, (client, target) => client.getOperation(target))
  register(KNOWLEDGE_CHAT_CHANNELS.search, (client, request) => client.search(request))
  register(KNOWLEDGE_CHAT_CHANNELS.getSourceUnit, (client, target) => client.getSourceUnit(target))
}
