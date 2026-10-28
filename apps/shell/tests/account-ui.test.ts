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
import { Home } from '../src/renderer/src/Home'
import { AccountMcpBalanceBanner } from '../src/renderer/src/AccountMcpSettings'
import { accountBalanceText, useAccount } from '../src/renderer/src/use-account'
import { KnowledgeWallet } from '../src/renderer/src/KnowledgeWallet'

let host: HTMLDivElement
let root: Root
const openRecharge = vi.fn<(product: OfficeBillingProduct) => Promise<void>>()
const getAccountUsage = vi.fn<HomeApi['getAccountUsage']>()
const getAccountSession = vi.fn<HomeApi['getAccountSession']>()
const getFangtangMcpEnabled = vi.fn<HomeApi['getFangtangMcpEnabled']>()
const setFangtangMcpEnabled = vi.fn<HomeApi['setFangtangMcpEnabled']>()
let mcpEnabledListener: ((enabled: boolean) => void) | undefined
let sessionListener: ((view: AccountView) => void) | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  openRecharge.mockReset().mockResolvedValue(undefined)
  getFangtangMcpEnabled.mockReset().mockResolvedValue(true)
  setFangtangMcpEnabled.mockReset().mockImplementation(async (enabled) => enabled)
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
      recents: async () => ({ entries: [], total: 0 }),
      starred: async () => ({ entries: [], total: 0 }),
      getFangtangMcpEnabled,
      setFangtangMcpEnabled,
      onFangtangMcpEnabledChanged: (listener: (enabled: boolean) => void) => {
        mcpEnabledListener = listener
        return () => {
          mcpEnabledListener = undefined
        }
      },
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

function KnowledgeAccountView() {
  const account = useAccount()
  return createElement(KnowledgeWallet, { usage: account.usage, language: 'zh' })
}

function knowledgeUsage(balanceCny: string): AccountUsage {
  return {
    knowledge: {
      product: 'knowledge_base',
      available: true,
      unavailableReason: null,
      walletStatus: 'opened',
      balanceCny,
      availableCny: balanceCny,
      reservedCny: '0.00',
      queryReserveCny: '0.01',
    },
  }
}

it('clears knowledge money on an account switch and ignores an old account refresh that arrives last', async () => {
  getAccountUsage.mockResolvedValueOnce(knowledgeUsage('12.00'))
  await act(async () => root.render(createElement(KnowledgeAccountView)))
  expect(host.textContent).toContain('¥12.00')
  let finishOld!: (usage: AccountUsage) => void
  let finishNew!: (usage: AccountUsage) => void
  getAccountUsage.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOld = resolve
    }),
  )
  await act(async () => window.dispatchEvent(new Event('focus')))
  getAccountUsage.mockReturnValueOnce(
    new Promise((resolve) => {
      finishNew = resolve
    }),
  )
  await act(async () => sessionListener?.({ loggedIn: true, userId: 'account-B' }))
  expect(host.textContent).not.toContain('¥12.00')
  expect(host.textContent).toContain('暂未获取知识资金状态')
  await act(async () => finishNew(knowledgeUsage('2.00')))
  await act(async () => finishOld(knowledgeUsage('99.00')))
  expect(host.textContent).toContain('¥2.00')
  expect(host.textContent).not.toContain('¥99.00')
})

it('clears knowledge money after sign-out and does not restore it from a late response', async () => {
  getAccountUsage.mockResolvedValueOnce(knowledgeUsage('12.00'))
  await act(async () => root.render(createElement(KnowledgeAccountView)))
  let finish!: (usage: AccountUsage) => void
  getAccountUsage.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  await act(async () => window.dispatchEvent(new Event('focus')))
  await act(async () => sessionListener?.({ loggedIn: false }))
  await act(async () => finish(knowledgeUsage('99.00')))
  expect(host.textContent).not.toContain('¥12.00')
  expect(host.textContent).not.toContain('¥99.00')
  expect(host.textContent).toContain('暂未获取知识资金状态')
})

function McpHomeNotice() {
  return createElement(AccountMcpBalanceBanner, { account: useAccount() })
}

describe('account wallet UI', () => {
  it('opens cloud knowledge from Home without bypassing sign-in', async () => {
    getAccountSession.mockResolvedValue({ loggedIn: false })
    await act(async () =>
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(Home),
        }),
      ),
    )
    const entry = host.querySelector<HTMLButtonElement>('[data-action="knowledge"]')
    expect(entry).not.toBeNull()
    await act(async () => entry!.click())
    expect(host.textContent).toContain('Sign in to view cloud knowledge')
  })

  it('lets signed-out users reach the MCP opt-out from Home without signing in', async () => {
    getAccountSession.mockResolvedValue({ loggedIn: false })
    await act(async () =>
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(Home),
        }),
      ),
    )
    const settings = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Settings',
    )
    expect(settings).toBeDefined()
    await act(async () => settings!.click())
    const account = Array.from(host.querySelectorAll<HTMLButtonElement>('.set-nav-item')).find(
      (button) => button.textContent?.trim() === 'Account',
    )!
    await act(async () => account.click())
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => toggle.click())
    expect(setFangtangMcpEnabled).toHaveBeenCalledWith(false)
  })

  it('shows the default-enabled MCP switch and saves an explicit opt-out without recharging', async () => {
    await mountSettings()
    const toggle = host.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Enable Fangtang MCP"]',
    )
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle!.click())
    expect(setFangtangMcpEnabled).toHaveBeenCalledWith(false)
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    expect(openRecharge).not.toHaveBeenCalled()
  })

  it('warns when MCP available funds cannot pay one call and opens only the MCP wallet', async () => {
    getAccountUsage.mockResolvedValue({
      products: {
        office_ai: { balanceCny: '100.00' },
        policy_mcp: {
          balanceCny: '15.00',
          availableCny: '0.49',
          walletStatus: 'opened',
          pricing: { unitPriceFen: 50 },
        },
      },
    })
    await mountSettings()
    const warning = host.querySelector('[role="status"]')
    expect(warning?.textContent).toContain('Fangtang MCP available balance is insufficient')
    const recharge = warning?.querySelector<HTMLButtonElement>('button')
    expect(recharge).not.toBeNull()
    await act(async () => recharge!.click())
    expect(openRecharge).toHaveBeenCalledExactlyOnceWith('policy_mcp')
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps the MCP preference accessible when signed out and restores a saved opt-out', async () => {
    getAccountSession.mockResolvedValue({ loggedIn: false })
    getFangtangMcpEnabled.mockResolvedValue(false)
    await mountSettings()
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('Sign in to Fangtang to use it')
    await act(async () => toggle.click())
    expect(setFangtangMcpEnabled).toHaveBeenCalledWith(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('does not show an unsaved opt-out as successful', async () => {
    setFangtangMcpEnabled.mockRejectedValue(new Error('fixture write failure'))
    await mountSettings()
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'MCP settings could not be updated',
    )
  })

  it('keeps a newer MCP state broadcast instead of a late startup snapshot', async () => {
    let finish!: (enabled: boolean) => void
    getFangtangMcpEnabled.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    await mountSettings()
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.disabled).toBe(true)
    await act(async () => {
      mcpEnabledListener?.(false)
      finish(true)
    })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(false)
  })

  it('shows the independent MCP recharge reminder on Home and hides it on opt-out', async () => {
    getAccountUsage.mockResolvedValue({
      products: {
        office_ai: { balanceCny: '100.00' },
        policy_mcp: { availableCny: '0.00', pricing: { unitPriceFen: 50 } },
      },
    })
    await act(async () =>
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(McpHomeNotice),
        }),
      ),
    )
    const warning = host.querySelector('[role="status"]')!
    expect(warning.textContent).toContain('Fangtang MCP available balance is insufficient')
    await act(async () => warning.querySelector<HTMLButtonElement>('button')!.click())
    expect(openRecharge).toHaveBeenCalledExactlyOnceWith('policy_mcp')
    await act(async () => {
      mcpEnabledListener?.(false)
    })
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

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
