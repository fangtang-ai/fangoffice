import { test, expect } from '@playwright/test'
import type { OfficeBillingProduct } from '../packages/agent-core/src/billing'
import {
  HOME_CHANNELS,
  type AccountUsage,
  type AccountView,
} from '../apps/shell/src/shared/home-api'
import { closeAndSaveVideo, screenshotPath } from './helpers'
import { launchBillingShell } from './billing-fixture'

interface AccountFixture {
  session: AccountView
  usage: AccountUsage
  recharges: OfficeBillingProduct[]
}

type FixtureGlobal = typeof globalThis & { officeAccountFixture: AccountFixture }

test('keeps dual wallets, recharge targets and account switches consistent through Electron IPC', async () => {
  const launched = await launchBillingShell('account-wallet')
  const { app, page } = launched
  try {
    await app.evaluate(({ ipcMain, webContents }, channels) => {
      // Only the account service boundary is simulated; renderers, preload and focus events are real.
      const fixture: AccountFixture = {
        session: { loggedIn: true, userId: 'fixture-A', displayName: 'Fixture Account A' },
        usage: {
          products: {
            office_ai: { balanceCny: '8.00', monthPendingCny: '0.50' },
            policy_mcp: { balanceCny: '15.00', walletStatus: 'open' },
          },
        },
        recharges: [],
      }
      ;(globalThis as FixtureGlobal).officeAccountFixture = fixture
      for (const channel of [
        channels.getAccountSession,
        channels.getAccountUsage,
        channels.openRecharge,
        channels.logoutAccount,
      ]) {
        ipcMain.removeHandler(channel)
      }
      ipcMain.handle(channels.getAccountSession, () => fixture.session)
      ipcMain.handle(channels.getAccountUsage, () => fixture.usage)
      ipcMain.handle(channels.openRecharge, (_event, product: OfficeBillingProduct) => {
        fixture.recharges.push(product)
      })
      ipcMain.handle(channels.logoutAccount, () => {
        fixture.session = { loggedIn: false }
        for (const contents of webContents.getAllWebContents()) {
          contents.send('account:session-changed', fixture.session)
        }
      })
    }, HOME_CHANNELS)
    await page.reload()
    // Playwright otherwise emulates permanent focus, masking real recharge-return focus events.
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await expect(page.locator('.account-btn')).toHaveAccessibleName('Fixture Account A')
    await page.locator('.account-btn').click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.locator('.set-nav-item', { hasText: 'Account' }).click()
    await expect(settings).toContainText('¥8.00')
    await expect(settings).toContainText('¥15.00')

    const balanceField = settings.locator('.set-field').filter({
      has: page.locator('.set-field-label', { hasText: /^Balance$/ }),
    })
    const mcpField = settings.locator('.set-field').filter({
      has: page.locator('.set-field-label', { hasText: /^MCP balance$/ }),
    })
    await balanceField.getByRole('button', { name: 'Top up', exact: true }).click()
    await mcpField.getByRole('button', { name: 'Top up', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => (globalThis as FixtureGlobal).officeAccountFixture.recharges))
      .toEqual(['office_ai', 'policy_mcp'])

    await app.evaluate(() => {
      const fixture = (globalThis as FixtureGlobal).officeAccountFixture
      fixture.usage = {
        products: {
          office_ai: { balanceCny: '18.00' },
          policy_mcp: { balanceCny: '25.00', walletStatus: 'open' },
        },
      }
    })
    const homeWindow = await app.browserWindow(page)
    // A second native window reproduces leaving for recharge; blur alone retains focus on Windows.
    const rechargeWindow = await app.evaluateHandle(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({ width: 360, height: 240, show: false })
      await window.loadURL('about:blank')
      window.show()
      window.focus()
      return window
    })
    try {
      await expect.poll(() => homeWindow.evaluate((window) => window.isFocused())).toBe(false)
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      await homeWindow.evaluate((window) => window.focus())
      await expect.poll(() => homeWindow.evaluate((window) => window.isFocused())).toBe(true)
      await expect(settings).toContainText('¥18.00')
      await expect(settings).toContainText('¥25.00')
    } finally {
      await rechargeWindow.evaluate((window) => window.destroy())
      await rechargeWindow.dispose()
      await homeWindow.dispose()
    }

    await app.evaluate(({ webContents }) => {
      const fixture = (globalThis as FixtureGlobal).officeAccountFixture
      fixture.session = { loggedIn: true, userId: 'fixture-B', displayName: 'Fixture Account B' }
      fixture.usage = {
        products: {
          office_ai: { balanceCny: '2.00' },
          policy_mcp: { balanceCny: '3.00', walletStatus: 'open' },
        },
      }
      for (const contents of webContents.getAllWebContents()) {
        contents.send('account:session-changed', fixture.session)
      }
    })
    await expect(settings).toContainText('Fixture Account B')
    await expect(settings).toContainText('¥2.00')
    await expect(settings).toContainText('¥3.00')
    await expect(settings).not.toContainText('¥18.00')
    await expect(settings).not.toContainText('¥25.00')
    await page.screenshot({ path: screenshotPath('account-wallet-switched') })

    await settings.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(settings).not.toContainText('Fixture Account B')
    await expect(settings).not.toContainText('¥2.00')
    await expect(settings).not.toContainText('¥3.00')
  } finally {
    await closeAndSaveVideo(launched, 'account-wallet')
  }
})
