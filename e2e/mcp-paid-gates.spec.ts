import { test, expect, type Page } from '@playwright/test'
import { closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'
import { installPaidMcpFixture, launchBillingShell, paidFixtureCalls } from './billing-fixture'

const editors = ['docs', 'sheets', 'slides', 'markdown', 'pdf'] as const

async function sendPrompt(page: Page, prompt: string) {
  await page.locator('.ai-input-box textarea').fill(prompt)
  await page.locator('.ai-send-btn:not(.ai-stop-btn)').click()
}

async function prepareEditor(editor: (typeof editors)[number], name: string) {
  const launched = await launchBillingShell(name)
  try {
    await installPaidMcpFixture(launched.app)
    await launched.page.locator('.quick-card').nth(editors.indexOf(editor)).click()
    const page = await waitForPageWithUrl(launched.app, `${editor}/out`)
    await expect(page.locator('.ai-input-box textarea')).toBeVisible()
    return { launched, page }
  } catch (error) {
    await closeAndSaveVideo(launched, name)
    throw error
  }
}

for (const editor of editors) {
  test(`${editor}: first prompt discloses paid calls and confirms call eleven without replaying completed calls`, async () => {
    const name = `mcp-paid-gates-${editor}`
    const { launched, page } = await prepareEditor(editor, name)
    const { app } = launched
    try {
      await sendPrompt(page, 'Execute the isolated paid-tool fixture')
      const gate = page.locator('.ai-recharge-overlay[role="dialog"]')
      await expect(gate).toContainText('each call costs')
      expect(await paidFixtureCalls(app)).toHaveLength(0)
      await gate.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(gate).toContainText('10 paid MCP calls (limit 10)')
      expect(await paidFixtureCalls(app)).toHaveLength(10)
      await page.screenshot({ path: screenshotPath(`${name}-limit`) })

      await gate.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.getByText('Fixture task complete', { exact: true })).toBeVisible()
      await expect(gate).not.toBeVisible()
      const calls = await paidFixtureCalls(app)
      expect(calls).toHaveLength(11)
      expect(new Set(calls.map((call) => call.context.aiRunId)).size).toBe(1)
      expect(new Set(calls.map((call) => call.context.logicalCallId)).size).toBe(11)
      for (const call of calls) {
        expect(call.server).toBe('fixture')
        expect(call.tool).toBe('search')
        expect(call.context.aiRunId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
        expect(call.context.logicalCallId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
      }
    } finally {
      await closeAndSaveVideo(launched, name)
    }
  })
}

for (const boundary of ['disclosure', 'limit'] as const) {
  test(`declining the ${boundary} sends no unapproved paid calls`, async () => {
    const name = `mcp-decline-${boundary}`
    const { launched, page } = await prepareEditor('markdown', name)
    try {
      await sendPrompt(page, 'Execute the isolated paid-tool fixture')
      const gate = page.locator('.ai-recharge-overlay[role="dialog"]')
      await expect(gate).toContainText('each call costs')
      if (boundary === 'limit') {
        await gate.getByRole('button', { name: 'Continue', exact: true }).click()
        await expect(gate).toContainText('10 paid MCP calls (limit 10)')
      }
      await gate.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect(gate).not.toBeVisible()
      await expect(page.locator('.ai-send-btn:not(.ai-stop-btn)')).toBeVisible()
      expect(await paidFixtureCalls(launched.app)).toHaveLength(boundary === 'limit' ? 10 : 0)
    } finally {
      await closeAndSaveVideo(launched, name)
    }
  })
}
