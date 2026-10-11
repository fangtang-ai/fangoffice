/**
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeBillingProduct } from '@genoffice/agent-core'
import type { AccountUsage, AccountView, HomeApi } from '../src/shared/home-api'
import { LocaleProvider } from '../src/renderer/src/locale'
import { SettingsModal } from '../src/renderer/src/SettingsModal'
import { accountBalanceText, useAccount } from '../src/renderer/src/use-account'

let host: HTMLDivElement
let root: Root
const openRecharge = vi.fn<(product: OfficeBillingProduct) => Promise<void>>()
const getAccountUsage = vi.fn<HomeApi['getAccountUsage']>()
const getAccountSession = vi.fn<HomeApi['getAccountSession']>()
let sessionListener: ((view: AccountView) => void) | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  openRecharge.mockReset().mockResolvedValue(undefined)
  getAccountSession.mockReset().mockResolvedValue({ loggedIn: true, userId: 'account-A' })
  getAccountUsage.mockReset().mockResolvedValue({
    products: {
      office_ai: { balanceCny: '8.00', monthPendingCny: '0.50' },
      policy_mcp: { balanceCny: '15.00', walletStatus: 'open' },
    },
  })
  Object.defineProperty(window, 'aiOffice', {
    configurable: true,
    value: {
      getTheme: async () => 'system',
      getDefaultSaveDir: async () => '',
      getAnalyticsEnabled: async () => true,
      getUpdateChannel: async () => 'stable',
      getAppVersion: async () => '0.9.4',
      getAccountSession,
      onAccountSessionChanged: (listener: (view: AccountView) => void) => {
        sessionListener = listener
        return () => {
          sessionListener = undefined
        }
      },
      getAccountUsage,
      openRecharge,
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function mountSettings() {
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(SettingsModal, { onClose: vi.fn() }),
      }),
    )
  })
  const account = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find(
    (button) => button.textContent?.trim() === 'Account',
  )
  if (!account) throw new Error('Account settings entry is missing')
  await act(async () => account.click())
}

function rechargeButton(label: string) {
  const field = Array.from(host.querySelectorAll('.set-field')).find(
    (row) => row.querySelector('.set-field-label')?.textContent === label,
  )
  const button = field?.querySelector('button')
  if (!button) throw new Error(`Recharge button is missing for ${label}`)
  return button
}

function RefreshingAccount() {
  const account = useAccount()
  useEffect(() => {
    if (account.loggedIn) account.refreshUsage()
  }, [account.loggedIn, account.refreshUsage])
  return createElement('div', null, accountBalanceText(account.usage) ?? 'pending')
}

describe('account wallet UI', () => {
  it('keeps a newer session broadcast when the initial session query arrives late', async () => {
    let resolveInitialSession!: (view: AccountView) => void
    getAccountSession.mockReturnValueOnce(
      new Promise((resolveSession) => {
        resolveInitialSession = resolveSession
      }),
    )
    await mountSettings()
    await act(async () => {
      sessionListener?.({ loggedIn: true, userId: 'account-B', displayName: 'Account B' })
    })
    expect(host.textContent).toContain('Account B')

    await act(async () => {
      resolveInitialSession({ loggedIn: true, userId: 'account-A' })
    })
    expect(host.textContent).toContain('Account B')
    expect(host.textContent).not.toContain('account-A')
  })

  it('keeps the visible-account refresh stable instead of repeatedly requesting each rendered balance', async () => {
    let requests = 0
    getAccountUsage.mockImplementation(async () => {
      requests += 1
      if (requests > 3) return new Promise<AccountUsage | null>(() => {})
      return { balanceCny: '8.00' }
    })
    await act(async () => {
      root.render(createElement(RefreshingAccount))
    })

    expect(host.textContent).toBe('¥8.00')
    expect(getAccountUsage).toHaveBeenCalledTimes(1)
  })

  it('offers independent AI and MCP recharge actions beside the actual balances', async () => {
    await mountSettings()
    expect(host.textContent).toContain('¥8.00')
    expect(host.textContent).toContain('¥15.00')

    await act(async () => rechargeButton('Balance').click())
    expect(openRecharge).toHaveBeenLastCalledWith('office_ai')

    await act(async () => rechargeButton('MCP balance').click())
    expect(openRecharge).toHaveBeenLastCalledWith('policy_mcp')
  })

  it('clears the previous wallets immediately on an account switch and loads the new account', async () => {
    await mountSettings()
    let resolveNewUsage!: (usage: AccountUsage | null) => void
    getAccountUsage.mockReturnValueOnce(
      new Promise((resolveUsage) => {
        resolveNewUsage = resolveUsage
      }),
    )

    await act(async () => {
      sessionListener?.({ loggedIn: true, userId: 'account-B', displayName: 'Account B' })
    })
    expect(host.textContent).toContain('Account B')
    expect(host.textContent).not.toContain('¥8.00')
    expect(host.textContent).not.toContain('¥15.00')

    await act(async () => {
      resolveNewUsage({
        products: {
          office_ai: { balanceCny: '2.00' },
          policy_mcp: { balanceCny: '3.00', walletStatus: 'open' },
        },
      })
    })
    expect(host.textContent).toContain('¥2.00')
    expect(host.textContent).toContain('¥3.00')
  })

  it('ignores a late recharge refresh from the previous account', async () => {
    await mountSettings()
    let resolveOldUsage!: (usage: AccountUsage | null) => void
    getAccountUsage.mockReturnValueOnce(
      new Promise((resolveUsage) => {
        resolveOldUsage = resolveUsage
      }),
    )
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    getAccountUsage.mockResolvedValueOnce({
      products: {
        office_ai: { balanceCny: '2.00' },
        policy_mcp: { balanceCny: '3.00', walletStatus: 'open' },
      },
    })
    await act(async () => {
      sessionListener?.({ loggedIn: true, userId: 'account-B' })
    })
    expect(host.textContent).toContain('¥2.00')

    await act(async () => {
      resolveOldUsage({ products: { office_ai: { balanceCny: '99.00' } } })
    })
    expect(host.textContent).toContain('¥2.00')
    expect(host.textContent).toContain('¥3.00')
    expect(host.textContent).not.toContain('¥99.00')
  })
})
