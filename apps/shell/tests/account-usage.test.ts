import { describe, expect, it } from 'vitest'
import type { AccountUsage } from '../src/shared/home-api'
import {
  accountAiPendingText,
  accountBalanceCny,
  accountBalanceText,
  accountMcpBalanceText,
  accountMcpPendingText,
  accountMcpUsage,
  accountMcpUsedText,
  accountMcpWalletOpened,
  accountMonthUsedText,
} from '../src/renderer/src/use-account'

function usage(payload: Record<string, unknown>): AccountUsage {
  return payload as unknown as AccountUsage
}

const legacy = usage({ balanceCny: '12.34', monthUsedCny: '3.2' })

const dual = usage({
  products: {
    office_ai: { balanceCny: '8.00', monthChargedCny: '2.5', monthPendingCny: '0.5' },
    policy_mcp: {
      balanceCny: '15',
      monthChargedCny: '5.00',
      monthPendingCny: '1.00',
      walletStatus: 'open',
    },
  },
})

const mcpNotOpened = usage({
  products: { office_ai: { balanceCny: '8.00' }, policy_mcp: { walletStatus: 'not_opened' } },
})

describe('account usage helpers', () => {
  it('parses the legacy top-level fields first and falls back to the AI product entry', () => {
    expect(accountBalanceCny(legacy)).toBe(12.34)
    expect(accountBalanceCny(dual)).toBe(8)
    expect(accountBalanceCny(null)).toBeNull()
    expect(accountMonthUsedText(legacy)).toBe('¥3.20')
    expect(accountMonthUsedText(dual)).toBe('¥2.50')
    // dual shape without a legacy top-level field wins over absent office_ai
    expect(accountBalanceText(dual)).toBe('¥8.00')
  })

  it('returns null for absent or unparseable amounts instead of fabricating values', () => {
    expect(accountBalanceCny(usage({}))).toBeNull()
    expect(accountBalanceCny(usage({ balanceCny: 'abc' }))).toBeNull()
    expect(accountBalanceCny(usage({ balanceCny: '' }))).toBeNull()
    expect(accountBalanceText(usage({ balanceCny: Number.NaN }))).toBeNull()
  })

  it('reads the AI pending amount only from the products map', () => {
    expect(accountAiPendingText(dual)).toBe('¥0.50')
    expect(accountAiPendingText(legacy)).toBeNull()
    expect(accountAiPendingText(null)).toBeNull()
  })

  it('exposes the MCP product entry and hides rows on legacy payloads', () => {
    expect(accountMcpUsage(dual)).toEqual(dual.products?.policy_mcp)
    expect(accountMcpUsage(legacy)).toBeNull()
    expect(accountMcpBalanceText(dual)).toBe('¥15.00')
    expect(accountMcpUsedText(dual)).toBe('¥5.00')
    expect(accountMcpPendingText(dual)).toBe('¥1.00')
    expect(accountMcpBalanceText(legacy)).toBeNull()
  })

  it('reports MCP wallet state, unknown when the payload has no products map', () => {
    expect(accountMcpWalletOpened(dual)).toBe(true)
    expect(accountMcpWalletOpened(mcpNotOpened)).toBe(false)
    expect(accountMcpWalletOpened(legacy)).toBeNull()
    expect(accountMcpWalletOpened(null)).toBeNull()
    expect(accountMcpBalanceText(mcpNotOpened)).toBeNull()
  })
})
