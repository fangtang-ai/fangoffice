import { useEffect, useState } from 'react'
import type { AccountErrorCode, AccountUsage, AccountView } from '../../shared/home-api'
import { useI18n } from './locale'
import type { StringKey } from './locale'

/** stable account error codes → localized strings (renderer-side) */
export const ACCOUNT_ERR_KEYS = {
  'account:not-configured': 'accountErrNotConfigured',
  'account:busy': 'accountErrBusy',
  'account:canceled': 'accountErrCanceled',
  'account:timeout': 'accountErrTimeout',
  'account:failed': 'accountErrFailed',
  'account:expired': 'accountErrExpired',
} as const satisfies Record<AccountErrorCode, StringKey>

/** parse the site's decimal ¥ fields ('0.00' strings since the fangtang
 * billing update) into numbers; null for absent/other non-numeric shapes */
function parseCny(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** formatted ¥ ('¥12.34'); null for absent/unparseable values */
function fmtCny(value: unknown): string | null {
  const cny = parseCny(value)
  return cny === null ? null : `¥${cny.toFixed(2)}`
}

/** one product entry from the site's products map (office_ai / policy_mcp);
 * null on legacy payloads without the products map */
function productUsage(usage: AccountUsage, product: string): Record<string, unknown> | null {
  const products = usage.products
  if (!products || typeof products !== 'object') return null
  const entry = (products as Record<string, unknown>)[product]
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
}

/** balance in ¥ from the site's usage payload; null when absent/unshaped.
 * Prefers the legacy top-level field, falls back to the AI product entry */
export function accountBalanceCny(usage: AccountUsage | null): number | null {
  if (!usage) return null
  return parseCny(usage.balanceCny) ?? parseCny(productUsage(usage, 'office_ai')?.balanceCny)
}

/** formatted balance ('¥12.34'), null when absent — display-only convenience */
export function accountBalanceText(usage: AccountUsage | null): string | null {
  const cny = accountBalanceCny(usage)
  return cny === null ? null : `¥${cny.toFixed(2)}`
}

/** formatted month-to-date spend ('¥3.20'), null when the site gives none.
 * Legacy top-level monthUsedCny, falls back to office_ai.monthChargedCny */
export function accountMonthUsedText(usage: AccountUsage | null): string | null {
  if (!usage) return null
  const used =
    parseCny(usage.monthUsedCny) ?? parseCny(productUsage(usage, 'office_ai')?.monthChargedCny)
  return used === null ? null : `¥${used.toFixed(2)}`
}

/** AI month-to-date pending amount (reserved, not yet billed) */
export function accountAiPendingText(usage: AccountUsage | null): string | null {
  if (!usage) return null
  return fmtCny(productUsage(usage, 'office_ai')?.monthPendingCny)
}

/** the MCP product entry (policy_mcp); null on legacy payloads — callers hide
 * the MCP rows entirely rather than showing dashes */
export function accountMcpUsage(usage: AccountUsage | null): Record<string, unknown> | null {
  return usage ? productUsage(usage, 'policy_mcp') : null
}

export function accountMcpBalanceText(usage: AccountUsage | null): string | null {
  return fmtCny(accountMcpUsage(usage)?.balanceCny)
}

export function accountMcpUsedText(usage: AccountUsage | null): string | null {
  return fmtCny(accountMcpUsage(usage)?.monthChargedCny)
}

export function accountMcpPendingText(usage: AccountUsage | null): string | null {
  return fmtCny(accountMcpUsage(usage)?.monthPendingCny)
}

/** MCP wallet opened? null = unknown (legacy payload without walletStatus) */
export function accountMcpWalletOpened(usage: AccountUsage | null): boolean | null {
  const mcp = accountMcpUsage(usage)
  if (!mcp) return null
  return mcp.walletStatus !== 'not_opened'
}

/**
 * Shared 方塘 account state: session, balance, and the login/logout/recharge
 * actions with stable error codes. Consumers each hold their own instance —
 * session changes are broadcast from main, so instances stay in sync.
 */
export function useAccount() {
  const { t } = useI18n()
  const [session, setSession] = useState<AccountView | null>(null)
  const [usage, setUsage] = useState<AccountUsage | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<AccountErrorCode | null>(null)

  useEffect(() => {
    let active = true
    void window.aiOffice.getAccountSession().then((view) => {
      if (active) setSession(view)
    })
    // login/logout/expiry anywhere (incl. another window) re-renders consumers
    const unsubscribe = window.aiOffice.onAccountSessionChanged((view) => {
      setSession(view)
      setBusy(false)
      setErrorText(null)
      setErrorCode(null)
      if (!view.loggedIn) setUsage(null)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  // balance: pull on sign-in, on window focus (editors cover the shell while
  // consuming credits, so focus is when the user can actually see this UI),
  // and whenever the session flips to signed-in
  useEffect(() => {
    if (!session?.loggedIn) return
    const pull = () => {
      void window.aiOffice.getAccountUsage().then(setUsage)
    }
    pull()
    window.addEventListener('focus', pull)
    return () => window.removeEventListener('focus', pull)
  }, [session?.loggedIn])

  const login = async () => {
    setBusy(true)
    setErrorText(null)
    setErrorCode(null)
    try {
      setSession(await window.aiOffice.loginAccount())
    } catch (e) {
      // electron prefixes IPC rejections with the error class, so the stable
      // account:* code stays greppable in the renderer
      const code = /account:(not-configured|busy|canceled|timeout|failed|expired)/.exec(
        String(e),
      )?.[1]
      if (code) setErrorCode(`account:${code}` as AccountErrorCode)
      setErrorText(
        code ? t(ACCOUNT_ERR_KEYS[`account:${code}` as AccountErrorCode]) : t('accountErrFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return {
    session,
    usage,
    busy,
    errorText,
    errorCode,
    loggedIn: session?.loggedIn ?? false,
    name: session?.displayName || session?.userId || '',
    balanceCny: accountBalanceCny(usage),
    login,
    /** re-pull the balance (Home calls this when its tab becomes visible) */
    refreshUsage: () => {
      if (session?.loggedIn) void window.aiOffice.getAccountUsage().then(setUsage)
    },
    logout: () => void window.aiOffice.logoutAccount(),
    recharge: () => void window.aiOffice.openRecharge(),
  }
}

export type AccountApi = ReturnType<typeof useAccount>
