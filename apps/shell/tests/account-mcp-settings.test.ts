import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { McpHub } from '@genoffice/mcp-bridge'
import { readAppSettings } from '../src/main/app-settings'
import { registerAccountMcpSettings } from '../src/main/account-mcp-settings'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      fixture.handlers.set(name, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: fixture.send } }],
  },
}))

let directory: string
let path: string
const hubs: McpHub[] = []
function createHub() {
  const hub = new McpHub({
    office: {
      transport: 'http',
      auth: 'fangtang-account',
      enabled: true,
      alwaysAvailable: true,
      url: '${ACCOUNT_API_BASE}/api/office/mcp',
    },
    custom: { transport: 'stdio', enabled: true, alwaysAvailable: true, command: 'fixture' },
  })
  hubs.push(hub)
  return hub
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'office-mcp-settings-'))
  path = join(directory, 'app-settings.json')
  fixture.handlers.clear()
  fixture.send.mockReset()
})
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.shutdown()))
  rmSync(directory, { recursive: true, force: true })
})

it('defaults on, persists an opt-out and restores it while preserving other settings and MCPs', async () => {
  writeFileSync(path, JSON.stringify({ language: 'zh' }))
  const hub = createHub()
  registerAccountMcpSettings(hub, path)
  expect(await fixture.handlers.get('home:get-fangtang-mcp-enabled')!({})).toBe(true)
  expect(await fixture.handlers.get('home:set-fangtang-mcp-enabled')!({}, false)).toBe(false)
  expect(hub.alwaysAvailableServers()).toEqual(['custom'])
  expect(readAppSettings(path)).toEqual({ language: 'zh', fangtangMcpEnabled: false })
  expect(fixture.send).toHaveBeenCalledWith('mcp:account-enabled-changed', false)
  const restarted = createHub()
  registerAccountMcpSettings(restarted, path)
  expect(await fixture.handlers.get('home:get-fangtang-mcp-enabled')!({})).toBe(false)
  expect(restarted.status().find((server) => server.name === 'office')?.enabled).toBe(false)
  expect(await fixture.handlers.get('home:set-fangtang-mcp-enabled')!({}, true)).toBe(true)
  expect(restarted.alwaysAvailableServers()).toEqual(['office', 'custom'])
})

it('does not change live state or broadcast success if persistence fails or input is invalid', async () => {
  const hub = createHub()
  registerAccountMcpSettings(hub, directory)
  const set = fixture.handlers.get('home:set-fangtang-mcp-enabled')!
  await expect(set({}, false)).rejects.toThrow()
  await expect(set({}, 'false')).rejects.toThrow('Invalid Fangtang MCP preference')
  expect(hub.isAccountEnabled()).toBe(true)
  expect(fixture.send).not.toHaveBeenCalled()
})
