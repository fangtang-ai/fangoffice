import { beforeEach, expect, it, vi } from 'vitest'
import { McpHub } from '../src/hub'

const fixture = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      fixture.handlers.set(name, handler),
  },
}))
import { registerMcpIpc } from '../src/ipc'

beforeEach(() => fixture.handlers.clear())

it('forwards only validated application context over the public MCP IPC boundary', async () => {
  const hub = new McpHub({
    wiki: { transport: 'http', enabled: true, url: 'https://fixture.invalid' },
  })
  const call = vi.spyOn(hub, 'callTool').mockResolvedValue({ text: 'ok', isError: false })
  registerMcpIpc(hub)
  const context = {
    aiRunId: 'f4245812-731b-43e0-a1b4-ef2810140b05',
    logicalCallId: '49520531-9c09-4915-8c40-7599c4385753',
  }
  const invoke = fixture.handlers.get('mcp:call-tool')!
  expect(
    await invoke(
      {},
      'wiki',
      'search',
      { query: 'business' },
      { ...context, token: 'must-not-forward' },
    ),
  ).toEqual({ text: 'ok', isError: false })
  expect(call).toHaveBeenCalledWith('wiki', 'search', { query: 'business' }, context)
  call.mockClear()
  expect(
    await invoke(
      {},
      'wiki',
      'search',
      {},
      { aiRunId: 'invalid', logicalCallId: context.logicalCallId },
    ),
  ).toEqual({ text: 'invalid_call_metadata', isError: true })
  expect(call).not.toHaveBeenCalled()
})
