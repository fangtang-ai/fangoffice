import { BrowserWindow, ipcMain } from 'electron'
import type { McpHub } from '@genoffice/mcp-bridge'
import { HOME_CHANNELS } from '../shared/home-api'
import { readAppSettings, writeAppSetting } from './app-settings'

export function registerAccountMcpSettings(hub: McpHub, settingsPath: string) {
  void hub.setAccountEnabled(readAppSettings(settingsPath).fangtangMcpEnabled !== false)
  ipcMain.handle(HOME_CHANNELS.getFangtangMcpEnabled, () => hub.isAccountEnabled())
  ipcMain.handle(HOME_CHANNELS.setFangtangMcpEnabled, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid Fangtang MCP preference.')
    // Persist first: a failed write must not present an opt-out that is lost after restart.
    writeAppSetting(settingsPath, 'fangtangMcpEnabled', enabled)
    await hub.setAccountEnabled(enabled)
    const current = hub.isAccountEnabled()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('mcp:account-enabled-changed', current)
    }
    return current
  })
}
