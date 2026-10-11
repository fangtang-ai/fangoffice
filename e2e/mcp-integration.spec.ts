import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HomeApi } from '../apps/shell/src/shared/home-api'
import { launchShell, closeAndSaveVideo } from './helpers'

test('Office discovers and calls a real stdio MCP server without replacing IPC', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'office-real-mcp-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({ onboardingSeen: true, analyticsEnabled: false, defaultSaveDir: userDataDir }),
  )
  await writeFile(
    join(userDataDir, 'fangtang-mcp.json'),
    JSON.stringify({
      mcpServers: {
        diagnostic: {
          transport: 'stdio',
          command: process.execPath,
          args: [join(__dirname, 'assets', 'mcp-diagnostic.mjs')],
          enabled: true,
          alwaysAvailable: true,
        },
      },
    }),
  )
  const launched = await launchShell({
    userDataDir,
    videoDir: 'mcp-real-stdio',
    recordVideo: false,
  })
  try {
    const before = await launched.page.evaluate(() =>
      (window as unknown as { aiOffice: HomeApi }).aiOffice.mcpStatus(),
    )
    expect(before).toContainEqual(
      expect.objectContaining({ name: 'diagnostic', transport: 'stdio', connected: false }),
    )
    const tools = await launched.page.evaluate(() =>
      (window as unknown as { aiOffice: HomeApi }).aiOffice.mcpListTools('diagnostic'),
    )
    expect(tools.map((tool) => tool.name)).toEqual(['diagnostic_ping'])
    for (const callNumber of [1, 2]) {
      const result = await launched.page.evaluate(() =>
        (window as unknown as { aiOffice: HomeApi }).aiOffice.mcpCallTool(
          'diagnostic',
          'diagnostic_ping',
          {},
        ),
      )
      expect(result.isError).toBe(false)
      expect(result.text).toBe(`diagnostic-pong:${callNumber}`)
      expect(result.billing).toBeUndefined()
    }
    const after = await launched.page.evaluate(() =>
      (window as unknown as { aiOffice: HomeApi }).aiOffice.mcpStatus(),
    )
    expect(after).toContainEqual(
      expect.objectContaining({ name: 'diagnostic', connected: true, toolCount: 1 }),
    )
  } finally {
    await closeAndSaveVideo(launched, 'mcp-real-stdio')
  }
})
