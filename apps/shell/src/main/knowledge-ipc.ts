import { randomUUID } from 'node:crypto'
import {
  createKnowledgeClient,
  KnowledgeClientError,
  type KnowledgeClient,
} from '@genoffice/knowledge-client'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { KNOWLEDGE_CHANNELS, type KnowledgeResult } from '../shared/knowledge-api'
import { getAccountKnowledgeAccess } from './auth'
import { KnowledgeDesktopError } from './knowledge-error'
import { createKnowledgeDocumentDeletion } from './knowledge-delete'
import { uploadKnowledgeText } from './knowledge-upload'

type KnowledgeRequest = {
  client: KnowledgeClient
  window: BrowserWindow
  check: () => void
  signal: AbortSignal
}

export function registerKnowledgeIpc(getWindow: () => BrowserWindow | null) {
  const register = <Value>(
    channel: string,
    work: (request: KnowledgeRequest, ...input: unknown[]) => Promise<Value>,
  ) => {
    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, ...input: unknown[]): Promise<KnowledgeResult<Value>> => {
        const host = getWindow()
        const trusted = () =>
          host !== null &&
          !host.isDestroyed() &&
          !host.webContents.isDestroyed() &&
          getWindow() === host &&
          event.sender === host.webContents &&
          event.senderFrame === host.webContents.mainFrame
        if (!host || !trusted()) return { ok: false, code: 'FORBIDDEN' }
        let client: KnowledgeClient | undefined
        try {
          const access = getAccountKnowledgeAccess()
          const binding = access.bind()
          // Pin each desktop operation to one account, including later SDK calls after an account change.
          const check = () => {
            if (!trusted() || binding.signal.aborted || !access.isCurrent(binding))
              throw new KnowledgeClientError('knowledge:account-changed')
          }
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
          const value = await work(
            { client, window: host, check, signal: binding.signal },
            ...input,
          )
          check()
          return { ok: true, value }
        } catch (error) {
          if (error instanceof KnowledgeDesktopError) return { ok: false, code: error.code }
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
  register(KNOWLEDGE_CHANNELS.listSpaces, ({ client }, page) => client.listSpaces(page ?? {}))
  register(KNOWLEDGE_CHANNELS.createSpace, ({ client }, title) =>
    client.createSpace({ spaceId: randomUUID() }, { title }),
  )
  register(KNOWLEDGE_CHANNELS.listDocuments, ({ client }, spaceId, page) =>
    client.listDocuments({ spaceId }, page ?? {}),
  )
  register(KNOWLEDGE_CHANNELS.getDocument, ({ client }, target) => client.getDocument(target))
  register(KNOWLEDGE_CHANNELS.deleteDocument, createKnowledgeDocumentDeletion())
  register(KNOWLEDGE_CHANNELS.getOperation, ({ client }, target) => client.getOperation(target))
  register(KNOWLEDGE_CHANNELS.getQuota, ({ client }) => client.getQuota())
  register(KNOWLEDGE_CHANNELS.search, ({ client }, request) => {
    // Desktop search stays within the current space; the contract owns cross-space scope.
    const { spaceId, query, limit } = (request ?? {}) as {
      spaceId?: unknown
      query?: unknown
      limit?: unknown
    }
    return client.search({
      scope: { kind: 'spaces', spaceIds: [spaceId] },
      query,
      ...(limit === undefined ? {} : { limit }),
    })
  })
  register(KNOWLEDGE_CHANNELS.getSourceUnit, ({ client }, target) => client.getSourceUnit(target))
  register(KNOWLEDGE_CHANNELS.uploadText, uploadKnowledgeText)
}
