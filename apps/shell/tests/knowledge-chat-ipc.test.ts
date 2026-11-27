import type { WebContents } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerKnowledgeChatIpc } from '../src/main/knowledge-chat-ipc'
import {
  AgentLoop,
  createKnowledgeChatApi,
  createKnowledgeSkill,
  type AgentStreamRequest,
  type AgentTransport,
} from '@genoffice/agent-core'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  controller: new AbortController(),
  sessionId: 1,
  token: vi.fn(async () => 'synthetic-token'),
  invalidate: () => {},
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      fixture.handlers.set(channel, handler),
  },
}))
vi.mock('../src/main/auth', () => ({
  onAccountSessionInvalidated: (listener: () => void) => {
    fixture.invalidate = listener
    return () => {}
  },
  getAccountKnowledgeAccess: () => ({
    apiBase: () => 'https://account.invalid',
    knowledgeBase: () => 'https://account.invalid/api/knowledge',
    bind: () => ({
      userId: 'account-A',
      sessionId: fixture.sessionId,
      signal: fixture.controller.signal,
    }),
    isCurrent: (binding: { sessionId: number }) => binding.sessionId === fixture.sessionId,
    token: fixture.token,
  }),
}))
const spaceId = '019a1234-0000-7000-8000-000000000001'
const mainFrame = {}
const contents = {
  id: 17,
  mainFrame,
  isDestroyed: () => false,
  once: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}
const editor = contents as unknown as WebContents
const event = { sender: editor, senderFrame: mainFrame }

beforeEach(() => {
  fixture.handlers.clear()
  fixture.controller = new AbortController()
  fixture.sessionId = 1
  fixture.token.mockClear()
  contents.send.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        items: [{ id: spaceId, title: '我的资料', state: 'active' }],
        nextCursor: null,
      }),
    ),
  )
  registerKnowledgeChatIpc(() => [editor])
})

it('notifies owned editors even when login changes before their first authenticated knowledge call', () => {
  fixture.invalidate()
  expect(contents.send).toHaveBeenCalledWith('knowledge:chat:session-changed')
})

it.each([
  { sender: { ...contents, id: 999 }, senderFrame: mainFrame },
  { sender: editor, senderFrame: {} },
])('rejects an unowned sender or subframe before acquiring an account token', async (untrusted) => {
  expect(await fixture.handlers.get('knowledge:chat:list-spaces')!(untrusted, 1, {})).toEqual({
    ok: false,
    code: 'FORBIDDEN',
  })
  expect(fixture.token).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects an old chat session before making a request as the newly signed-in account', async () => {
  fixture.sessionId = 2
  expect(await fixture.handlers.get('knowledge:chat:list-spaces')!(event, 1, {})).toEqual({
    ok: false,
    code: 'knowledge:account-changed',
  })
  expect(fixture.token).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('discards a cloud response when its original account is invalidated while HTTP is in flight', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fixture.controller.abort()
      fixture.sessionId = 2
      return Response.json({
        items: [{ id: spaceId, title: '旧账号私密空间', state: 'active' }],
        nextCursor: null,
      })
    }),
  )
  const result = await fixture.handlers.get('knowledge:chat:list-spaces')!(event, 1, {})
  expect(result).toEqual({ ok: false, code: 'knowledge:account-changed' })
  expect(JSON.stringify(result)).not.toContain('旧账号私密空间')
})
afterEach(() => vi.unstubAllGlobals())

it('lets an owned editor main frame read the account catalog through a fixed same-origin API without exposing tokens', async () => {
  expect(await fixture.handlers.get('knowledge:chat:session')!(event)).toEqual({
    ok: true,
    value: { userId: 'account-A', sessionId: 1 },
  })
  expect(await fixture.handlers.get('knowledge:chat:list-spaces')!(event, 1, {})).toEqual({
    ok: true,
    value: { items: [{ id: spaceId, title: '我的资料', state: 'active' }], nextCursor: null },
  })
  expect(vi.mocked(fetch).mock.calls[0][0].toString()).toBe(
    'https://account.invalid/api/knowledge/spaces?limit=20',
  )
  expect(fixture.handlers.has('knowledge:chat:upload')).toBe(false)
  expect(fixture.handlers.has('knowledge:chat:delete')).toBe(false)
})

it('feeds the actual catalog response into the normal model tool loop through preload, IPC and the account client without MCP', async () => {
  const title = '中原工学院关于新兴专业建设情况与对策建议.docx'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) =>
      Response.json(
        url.pathname.endsWith('/documents')
          ? {
              items: [
                {
                  id: spaceId,
                  spaceId,
                  title,
                  tags: [],
                  purpose: 'facts',
                  generation: '0',
                  active: null,
                  desired: null,
                  deletedAt: null,
                },
              ],
              nextCursor: null,
            }
          : { items: [{ id: spaceId, title: '我的资料', state: 'active' }], nextCursor: null },
      ),
    ),
  )
  const api = createKnowledgeChatApi({
    invoke: (channel, ...input) => fixture.handlers.get(channel)!(event, ...input),
    on: () => {},
    removeListener: () => {},
  })
  const requests: AgentStreamRequest[] = []
  const transport: AgentTransport = {
    stream: (request, callbacks) => {
      requests.push(request)
      queueMicrotask(() => {
        const name = requests.length === 1 ? 'list_knowledge_spaces' : 'list_knowledge_documents'
        if (requests.length <= 2)
          callbacks.onToolCall({
            id: `catalog-${requests.length}`,
            name,
            input: requests.length === 1 ? {} : { spaceId },
          })
        else callbacks.onDelta('目录中存在该文档，目前尚不可检索。')
        callbacks.onDone()
      })
      return { cancel: () => callbacks.onDone() }
    },
  }
  await new Promise<void>((resolve, reject) => {
    const loop = new AgentLoop({
      transport,
      skill: createKnowledgeSkill(api),
      events: { onDone: () => resolve(), onError: reject },
    })
    loop.run('不要使用MCP，看看知识库里有没有中原工学院的资料')
  })
  expect(requests).toHaveLength(3)
  expect(requests[0].tools.map((tool) => tool.name)).toContain('list_knowledge_documents')
  expect(JSON.stringify(requests[2].messages)).toContain(title)
  expect(JSON.stringify(requests[2].messages)).toContain('not_ready')
  expect(JSON.stringify(requests)).not.toContain('synthetic-token')
  expect(fetch).toHaveBeenCalledTimes(2)
})
