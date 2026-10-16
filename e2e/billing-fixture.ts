import type { ElectronApplication } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiSettings } from '../packages/ai-provider/src/types'
import { defaultAiSettings } from '../packages/ai-provider/src/providers'
import type { McpCallContext } from '../packages/agent-core/src/billing'
import type { IpcStreamStart } from '../packages/agent-core/src/electron-transport'
import { launchShell } from './helpers'

interface FixtureCall {
  server: string
  tool: string
  context: McpCallContext
}

type FixtureGlobal = typeof globalThis & { officeMcpFixtureCalls: FixtureCall[] }

export async function launchBillingShell(videoDir: string) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'office-billing-e2e-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      onboardingSeen: true,
      analyticsEnabled: false,
      defaultSaveDir: userDataDir,
    }),
  )
  return launchShell({ userDataDir, videoDir, recordVideo: false })
}

export async function installPaidMcpFixture(app: ElectronApplication) {
  const settings = defaultAiSettings({
    provider: 'custom',
    model: 'fixture-model',
    apiKey: 'fixture-only',
    baseUrl: 'http://127.0.0.1:9/never-requested',
  })
  await app.evaluate(({ ipcMain }, settings) => {
    const calls: FixtureCall[] = []
    const turns = new Map<string, number>()
    ;(globalThis as FixtureGlobal).officeMcpFixtureCalls = calls
    for (const channel of [
      'ai:get-settings',
      'ai:stream',
      'ai:stream-cancel',
      'mcp:status',
      'mcp:list-tools',
      'mcp:call-tool',
    ])
      ipcMain.removeHandler(channel)
    ipcMain.handle('ai:get-settings', () => settings)
    ipcMain.handle('mcp:status', () => [
      {
        name: 'fixture',
        transport: 'http',
        enabled: true,
        connected: true,
        alwaysAvailable: true,
        toolCount: 1,
        billingProduct: 'policy_mcp',
      },
    ])
    ipcMain.handle('mcp:list-tools', () => [
      {
        name: 'search',
        description: 'Isolated paid tool fixture',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ])
    ipcMain.handle(
      'mcp:call-tool',
      (
        _event,
        server: string,
        tool: string,
        _args: Record<string, unknown>,
        context: McpCallContext,
      ) => {
        if (!context) throw new Error('The application must attach run and call identifiers')
        calls.push({ server, tool, context })
        return {
          text: 'Fixture business result',
          isError: false,
          billing: { ...context, product: 'policy_mcp', status: 'settled', amountFen: 50 },
        }
      },
    )
    ipcMain.handle('ai:stream-cancel', () => {})
    ipcMain.handle('ai:stream', (event, request: IpcStreamStart<AiSettings>) => {
      const sendText = (text: string) => {
        event.sender.send('ai:stream-chunk', { requestId: request.requestId, type: 'delta', text })
        event.sender.send('ai:stream-chunk', { requestId: request.requestId, type: 'done' })
      }
      if (!request.aiRunId) throw new Error('The application must attach its own run identifier')
      const turn = turns.get(request.aiRunId) ?? 0
      turns.set(request.aiRunId, turn + 1)
      if (turn > 0) {
        sendText('Fixture task complete')
        return
      }
      if (!request.tools.some((tool) => tool.name === 'mcp__fixture__search')) {
        throw new Error('The fixture MCP tool must be offered to the model before execution')
      }
      // One model turn proposes eleven calls; the real agent and UI must pause before call eleven.
      for (let callIndex = 0; callIndex < 11; callIndex++) {
        event.sender.send('ai:stream-chunk', {
          requestId: request.requestId,
          type: 'tool-call',
          toolCall: { id: `fixture-tool-${callIndex}`, name: 'mcp__fixture__search', input: {} },
        })
      }
      event.sender.send('ai:stream-chunk', { requestId: request.requestId, type: 'done' })
    })
  }, settings)
}

export function paidFixtureCalls(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as FixtureGlobal).officeMcpFixtureCalls)
}
