import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { defaultAiSettings } from '../packages/ai-provider/src/providers'
import type { AiSettings } from '../packages/ai-provider/src/types'
import type { IpcStreamStart } from '../packages/agent-core/src/electron-transport'
import { launchBillingShell } from './billing-fixture'
import { closeAndSaveVideo, waitForPageWithUrl } from './helpers'

interface FixtureState {
  settings: AiSettings
  reads: number
  hold: boolean
  fail: boolean
  release?: () => void
  calls: { provider: string; model: string; hasStaticKey: boolean }[]
  toolResults: { id: string; output: unknown; isError?: boolean }[]
  turns: Record<string, number>
}
type FixtureGlobal = typeof globalThis & { sheetsAiFixture: FixtureState }

async function installFixture(app: ElectronApplication, configured: boolean) {
  const settings = defaultAiSettings({
    provider: 'fangtang',
    model: 'fixture-model-1',
    baseUrl: configured ? 'https://fixture.invalid/api/office/ai/chat' : '',
    apiKey: '',
  })
  await app.evaluate(({ ipcMain }, settings) => {
    const state: FixtureState = {
      settings,
      reads: 0,
      hold: false,
      fail: false,
      calls: [],
      toolResults: [],
      turns: {},
    }
    ;(globalThis as FixtureGlobal).sheetsAiFixture = state
    for (const channel of ['ai:get-settings', 'ai:stream', 'ai:stream-cancel', 'mcp:status']) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.handle('ai:get-settings', async () => {
      state.reads++
      if (state.hold)
        await new Promise<void>((resolve) => {
          state.release = resolve
        })
      if (state.fail) throw new Error('fixture-settings-unavailable')
      return state.settings
    })
    ipcMain.handle('mcp:status', () => [])
    ipcMain.handle('ai:stream-cancel', () => {})
    // Only the model IPC is simulated. The renderer, agent loop, workbook tools and save are real.
    ipcMain.handle('ai:stream', (event, request: IpcStreamStart<AiSettings>) => {
      const config = request.settings.providers[request.settings.provider]
      state.calls.push({
        provider: request.settings.provider,
        model: config.model,
        hasStaticKey: !!config.apiKey,
      })
      const send = (chunk: Record<string, unknown>) =>
        event.sender.send('ai:stream-chunk', {
          requestId: request.requestId,
          ...chunk,
        })
      const user = request.messages.filter((message) => message.role === 'user').at(-1)
      const instruction = user?.role === 'user' ? user.text : ''
      if (!instruction.includes('出生') && !instruction.includes('年龄')) {
        send({ type: 'delta', text: `fixture complete: ${config.model}` })
        send({ type: 'done' })
        return
      }
      const run = request.aiRunId ?? request.requestId
      state.toolResults = request.messages.flatMap((message) =>
        message.role === 'tool' ? message.results : [],
      )
      const turn = state.turns[run] ?? 0
      state.turns[run] = turn + 1
      if (turn === 0) {
        send({
          type: 'tool-call',
          toolCall: { id: `${run}-context`, name: 'get_workbook_context', input: {} },
        })
      } else if (turn === 1) {
        const context = request.messages
          .flatMap((message) => (message.role === 'tool' ? message.results : []))
          .find((result) => result.id === `${run}-context`)
        const sheetId = /Active sheet: .*?\(id=([^,)]+)/.exec(String(context?.output))?.[1]
        if (!sheetId) throw new Error('Fixture could not read the actual sheet ID')
        const calculate = instruction.includes('2026.11')
        send({
          type: 'tool-call',
          toolCall: {
            id: `${run}-write`,
            name: 'propose_operations',
            input: {
              summary: calculate ? '计算截至2026年11月的年龄' : '建立年龄计算样表',
              operations: [
                {
                  op: 'set_range',
                  sheetId,
                  start: calculate ? 'C2' : 'A1',
                  values: calculate
                    ? [[31], [34], [38]]
                    : [
                        ['姓名', '出生年月', '年龄'],
                        [1, '1995.04', null],
                        [2, '1991.12', null],
                        [3, '1988.02', null],
                      ],
                },
              ],
            },
          },
        })
      } else {
        const result = state.toolResults.find((item) => item.id === `${run}-write`)
        if (!result || result.isError) {
          send({ type: 'error', error: `Fixture workbook write failed: ${String(result?.output)}` })
          return
        }
        send({
          type: 'delta',
          text: instruction.includes('2026.11') ? '年龄已填写：31、34、38' : '样表已建立',
        })
      }
      send({ type: 'done' })
    })
  }, settings)
}

async function prepare(configured = true) {
  const launched = await launchBillingShell('sheets-managed-ai')
  try {
    await installFixture(launched.app, configured)
    await launched.page.locator('.quick-card').nth(1).click()
    const page = await waitForPageWithUrl(launched.app, 'sheets/out')
    await expect(page.locator('.ai-input-box textarea')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Demo edits stay in memory')
    return { launched, page }
  } catch (error) {
    await closeAndSaveVideo(launched, 'sheets-managed-ai')
    throw error
  }
}

async function send(page: Page, prompt: string) {
  await expect(page.locator('.ai-send-btn:not(.ai-stop-btn)')).toBeVisible()
  await page.locator('.ai-input-box textarea').fill(prompt)
  await page.locator('.ai-send-btn:not(.ai-stop-btn)').click()
}

test('sheets: managed login without a static key reaches the agent and fills the age column', async () => {
  const { launched, page } = await prepare()
  try {
    await send(page, '创建姓名、出生年月、年龄三列样表')
    await expect(page.getByText('样表已建立', { exact: true })).toBeVisible()
    await send(page, '将C列的年龄按照B列的出生日期，核算到2026.11月的年龄')
    await expect(page.getByText('年龄已填写：31、34、38', { exact: true })).toBeVisible()
    await expect(page.locator('.ai-chat')).not.toContainText('Try “set A1 to 42”')
    await expect(page.locator('.ai-send-btn:not(.ai-stop-btn)')).toBeVisible()
    // New workbooks keep AutoSave off; exercise the normal explicit save path.
    await launched.app.evaluate(({ webContents }) => {
      webContents
        .getAllWebContents()
        .find((view) => view.getURL().includes('sheets/out'))
        ?.send('menu:action', 'save')
    })
    const calls = await launched.app.evaluate(
      () => (globalThis as FixtureGlobal).sheetsAiFixture.calls,
    )
    expect(calls.length).toBeGreaterThanOrEqual(6)
    expect(calls.every((call) => call.provider === 'fangtang' && !call.hasStaticKey)).toBe(true)
    const folder = launched.userDataDir
    await expect(async () => {
      const file = (await readdir(folder)).find((name) => name.endsWith('.xlsx'))
      if (!file) throw new Error('Missing scratch workbook')
      const zip = await JSZip.loadAsync(await readFile(join(folder, file)))
      const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
      for (const [address, value] of [
        ['C2', 31],
        ['C3', 34],
        ['C4', 38],
      ]) {
        const cell = new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>([\\s\\S]*?)</c>`).exec(xml)?.[1]
        expect(cell).toContain(`<v>${value}</v>`)
      }
    }).toPass({ timeout: 15_000 })
    await page.screenshot({ path: test.info().outputPath('sheets-managed-age.png') })
  } finally {
    await writeFile(
      test.info().outputPath('model-tool-results.json'),
      JSON.stringify(
        await launched.app.evaluate(
          () => (globalThis as FixtureGlobal).sheetsAiFixture.toolResults,
        ),
        null,
        2,
      ),
    )
    await page.screenshot({ path: test.info().outputPath('sheets-managed-age.png') })
    await test.info().attach('model-tool-results.json', {
      body: JSON.stringify(
        await launched.app.evaluate(
          () => (globalThis as FixtureGlobal).sheetsAiFixture.toolResults,
        ),
        null,
        2,
      ),
      contentType: 'application/json',
    })
    await closeAndSaveVideo(launched, 'sheets-managed-ai')
  }
})

test('sheets: reads settings again after login and after a model change in the same window', async () => {
  const { launched, page } = await prepare(false)
  try {
    await send(page, 'set A1 to 42')
    await expect(page.locator('.ai-send-btn:not(.ai-stop-btn)')).toBeVisible()
    await launched.app.evaluate(() => {
      const state = (globalThis as FixtureGlobal).sheetsAiFixture
      state.settings.providers.fangtang.baseUrl = 'https://fixture.invalid/api/office/ai/chat'
    })
    await send(page, '确认当前模型')
    await expect(page.getByText('fixture complete: fixture-model-1', { exact: true })).toBeVisible()
    await launched.app.evaluate(() => {
      const state = (globalThis as FixtureGlobal).sheetsAiFixture
      state.settings.providers.fangtang.model = 'fixture-model-2'
    })
    await send(page, '再次确认当前模型')
    await expect(page.getByText('fixture complete: fixture-model-2', { exact: true })).toBeVisible()
    await launched.app.evaluate(() => {
      const { settings } = (globalThis as FixtureGlobal).sheetsAiFixture
      settings.provider = 'custom'
      settings.providers.custom = {
        model: 'fixture-custom',
        baseUrl: 'http://127.0.0.1:9/never-requested',
        apiKey: '',
      }
    })
    await send(page, '切换到自配模型')
    await expect(page.getByText('fixture complete: fixture-custom', { exact: true })).toBeVisible()
    expect(
      await launched.app.evaluate(() =>
        (globalThis as FixtureGlobal).sheetsAiFixture.calls.map((call) => call.model),
      ),
    ).toEqual(['fixture-model-1', 'fixture-model-2', 'fixture-custom'])
  } finally {
    await closeAndSaveVideo(launched, 'sheets-managed-refresh')
  }
})

test('sheets: cancelling a pending settings read prevents a late agent start', async () => {
  const { launched, page } = await prepare()
  try {
    await launched.app.evaluate(() => {
      ;(globalThis as FixtureGlobal).sheetsAiFixture.hold = true
    })
    await send(page, '确认当前模型')
    await expect
      .poll(() =>
        launched.app.evaluate(() => !!(globalThis as FixtureGlobal).sheetsAiFixture.release),
      )
      .toBe(true)
    await page.locator('.ai-stop-btn').click()
    await launched.app.evaluate(() => {
      const state = (globalThis as FixtureGlobal).sheetsAiFixture
      state.hold = false
      state.release?.()
    })
    await send(page, '取消后重新确认当前模型')
    await expect(page.getByText('fixture complete: fixture-model-1', { exact: true })).toBeVisible()
    expect(
      await launched.app.evaluate(() => (globalThis as FixtureGlobal).sheetsAiFixture.calls.length),
    ).toBe(1)
  } finally {
    await closeAndSaveVideo(launched, 'sheets-managed-cancel')
  }
})

test('sheets: a failed settings refresh reports an error and can be retried without a local fallback', async () => {
  const { launched, page } = await prepare()
  try {
    await launched.app.evaluate(() => {
      ;(globalThis as FixtureGlobal).sheetsAiFixture.fail = true
    })
    await send(page, '确认当前模型')
    await expect(page.locator('.ai-chat')).toContainText('fixture-settings-unavailable')
    await expect(page.locator('.ai-chat')).not.toContainText('Try “set A1 to 42”')
    expect(
      await launched.app.evaluate(() => (globalThis as FixtureGlobal).sheetsAiFixture.calls),
    ).toEqual([])
    await launched.app.evaluate(() => {
      ;(globalThis as FixtureGlobal).sheetsAiFixture.fail = false
    })
    await send(page, '恢复后确认当前模型')
    await expect(page.getByText('fixture complete: fixture-model-1', { exact: true })).toBeVisible()
  } finally {
    await closeAndSaveVideo(launched, 'sheets-managed-error')
  }
})

test('sheets: retry refreshes settings and replaces the failed exchange without duplicate sends', async () => {
  const { launched, page } = await prepare()
  try {
    await launched.app.evaluate(() => {
      ;(globalThis as FixtureGlobal).sheetsAiFixture.fail = true
    })
    await send(page, '重试当前请求')
    await expect(page.locator('.ai-retry-btn')).toBeVisible()
    await launched.app.evaluate(() => {
      const state = (globalThis as FixtureGlobal).sheetsAiFixture
      state.fail = false
      state.settings.providers.fangtang.model = 'fixture-retry-model'
    })
    await page.locator('.ai-retry-btn').click()
    await expect(
      page.getByText('fixture complete: fixture-retry-model', { exact: true }),
    ).toBeVisible()
    await expect(page.locator('.ai-msg-user')).toHaveCount(1)
    await expect(page.locator('.ai-msg-error')).toHaveCount(0)
    expect(
      await launched.app.evaluate(() => (globalThis as FixtureGlobal).sheetsAiFixture.calls.length),
    ).toBe(1)
  } finally {
    await closeAndSaveVideo(launched, 'sheets-managed-retry')
  }
})

test('sheets: starting a new conversation cancels a pending settings read', async () => {
  const { launched, page } = await prepare()
  try {
    await launched.app.evaluate(() => {
      ;(globalThis as FixtureGlobal).sheetsAiFixture.hold = true
    })
    await send(page, '清除前的请求')
    await expect
      .poll(() =>
        launched.app.evaluate(() => !!(globalThis as FixtureGlobal).sheetsAiFixture.release),
      )
      .toBe(true)
    await page.getByRole('button', { name: 'New conversation', exact: true }).click()
    await launched.app.evaluate(() => {
      const state = (globalThis as FixtureGlobal).sheetsAiFixture
      state.hold = false
      state.release?.()
    })
    await expect(page.locator('.ai-msg-user')).toHaveCount(0)
    await send(page, '新对话当前请求')
    await expect(page.getByText('fixture complete: fixture-model-1', { exact: true })).toBeVisible()
    await expect(page.locator('.ai-msg-user')).toHaveCount(1)
    expect(
      await launched.app.evaluate(() => (globalThis as FixtureGlobal).sheetsAiFixture.calls.length),
    ).toBe(1)
  } finally {
    await closeAndSaveVideo(launched, 'sheets-managed-new-chat')
  }
})
