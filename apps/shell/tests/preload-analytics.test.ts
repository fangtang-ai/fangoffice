import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeApi } from '../src/shared/home-api'
import { HOME_CHANNELS } from '../src/shared/home-api'

const electronMocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => electronMocks.exposed.set(name, api),
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
  // the preload imports @genoffice/electron-utils (drop-open bridge), which
  // binds webUtils at module scope even though node env never installs it
  webUtils: { getPathForFile: () => '' },
}))

import '../src/preload/index'

const homeApi = electronMocks.exposed.get('aiOffice') as HomeApi

describe('product-specific recharge preload API', () => {
  it('forwards the selected wallet to the main process', async () => {
    await homeApi.openRecharge('policy_mcp')
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(HOME_CHANNELS.openRecharge, 'policy_mcp')
  })
})

beforeEach(() => {
  electronMocks.invoke.mockReset()
  electronMocks.send.mockReset()
})

describe('Fangtang MCP preference preload API', () => {
  it('reads the default and forwards explicit opt-out booleans', async () => {
    electronMocks.invoke.mockResolvedValue(true)
    expect(await homeApi.getFangtangMcpEnabled()).toBe(true)
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(HOME_CHANNELS.getFangtangMcpEnabled)
    electronMocks.invoke.mockResolvedValue(false)
    expect(await homeApi.setFangtangMcpEnabled(false)).toBe(false)
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      HOME_CHANNELS.setFangtangMcpEnabled,
      false,
    )
    const setEnabled = homeApi.setFangtangMcpEnabled as (enabled: unknown) => Promise<boolean>
    await expect(setEnabled('false')).rejects.toThrow('Invalid Fangtang MCP preference')
  })
})

describe('analytics consent preload API', () => {
  it('defaults malformed main-process state to on', async () => {
    electronMocks.invoke.mockResolvedValue('invalid')
    await expect(homeApi.getAnalyticsEnabled()).resolves.toBe(true)
  })

  it('rejects non-boolean consent before invoking the main process', async () => {
    const setAnalytics = homeApi.setAnalyticsEnabled as (enabled: unknown) => Promise<boolean>

    await expect(setAnalytics('true')).rejects.toThrow('Invalid analytics consent')
    expect(electronMocks.invoke).not.toHaveBeenCalled()
  })

  it('forwards explicit booleans and reports persistence success', async () => {
    electronMocks.invoke.mockResolvedValue(true)

    await expect(homeApi.setAnalyticsEnabled(false)).resolves.toBe(true)
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(HOME_CHANNELS.setAnalyticsEnabled, false)

    await expect(homeApi.setOnboardingSeen()).resolves.toBe(true)
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(HOME_CHANNELS.setOnboardingSeen)
  })
})
