import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test.describe('home screen', () => {
  test('isolates native documents and disables analytics for a fresh profile', async () => {
    const launched = await launchShell({ videoDir: 'home-profile-isolation' })
    try {
      expect(await launched.app.evaluate(({ app }) => app.getPath('documents'))).toBe(
        launched.userDataDir,
      )
      const settings = JSON.parse(
        await readFile(join(launched.userDataDir, 'app-settings.json'), 'utf8'),
      ) as { analyticsEnabled?: boolean }
      expect(settings.analyticsEnabled).toBe(false)
    } finally {
      await closeAndSaveVideo(launched, 'home-profile-isolation')
    }
  })

  test('shows hero, quick-create cards and tab bar', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'home-basics' })
    const { page } = launched
    try {
      await expect(page.locator('.home-hero')).toBeVisible()
      // five AI quick-create cards plus the "Open file" browse card
      await expect(page.locator('.quick-card')).toHaveCount(6)
      await expect(page.locator('.quick-card').first()).toContainText('AI Docs')
      await expect(page.locator('.quick-card').nth(1)).toContainText('AI Sheets')
      await expect(page.locator('.quick-card').nth(2)).toContainText('AI Slides')
      await expect(page.locator('.quick-card').nth(3)).toContainText('AI Markdown')
      await expect(page.locator('.quick-card').nth(4)).toContainText('AI PDF')
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when FANGTANG_LANG=zh-CN', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'zh-CN',
      videoDir: 'home-zh-cn',
    })
    const { page } = launched
    try {
      await expect(page.locator('.nav-item .nav-label').first()).toHaveText('最近')
      await page.screenshot({ path: screenshotPath('home-zh-cn') })
    } finally {
      await closeAndSaveVideo(launched, 'home-zh-cn')
    }
  })
})
