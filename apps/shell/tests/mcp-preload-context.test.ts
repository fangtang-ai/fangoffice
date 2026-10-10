import { beforeEach, expect, it, vi } from 'vitest'
import type { McpRendererApi } from '@genoffice/agent-core'

const electronMocks = vi.hoisted(() => ({ exposed: new Map<string, unknown>(), invoke: vi.fn() }))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => electronMocks.exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: () => '' },
}))

beforeEach(() => {
  vi.resetModules()
  electronMocks.exposed.clear()
  electronMocks.invoke.mockReset()
})

const preloads = [
  { name: 'docs', key: 'desktop', load: () => import('../../docs/src/preload/index') },
  { name: 'sheets', key: 'desktopApi', load: () => import('../../sheets/src/preload/index') },
  { name: 'slides', key: 'slidesApi', load: () => import('../../slides/src/preload/index') },
  { name: 'pdf', key: 'pdfApi', load: () => import('../../pdf/src/preload/index') },
  { name: 'markdown', key: 'markdownApi', load: () => import('../../markdown/src/preload/index') },
  { name: 'shell', key: 'aiOffice', load: () => import('../src/preload/index') },
]

it.each(preloads)(
  '$name preload preserves typed task/call context and the billing response',
  async ({ key, load }) => {
    await load()
    const api = electronMocks.exposed.get(key) as { mcpCallTool: McpRendererApi['callTool'] }
    const context = {
      aiRunId: 'f4245812-731b-43e0-a1b4-ef2810140b05',
      logicalCallId: '49520531-9c09-4915-8c40-7599c4385753',
    }
    const result = {
      text: 'business',
      isError: false,
      billing: { ...context, product: 'policy_mcp', amountFen: 50 },
    }
    electronMocks.invoke.mockResolvedValue(result)
    expect(await api.mcpCallTool('policy', 'search', { query: 'business' }, context)).toEqual(
      result,
    )
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'mcp:call-tool',
      'policy',
      'search',
      { query: 'business' },
      context,
    )
  },
)
