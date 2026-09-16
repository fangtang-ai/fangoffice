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

/** balance in ¥ from the site's usage payload; null when absent/unshaped */
export function accountBalanceCny(usage: AccountUsage | null): number | null {
  return usage && typeof usage.balanceCny === 'number' ? usage.balanceCny : null
}

/** formatted balance ('¥12.34'), null when absent — display-only convenience */
export function accountBalanceText(usage: AccountUsage | null): string | null {
  const cny = accountBalanceCny(usage)
  return cny === null ? null : `¥${cny.toFixed(2)}`
}

/** formatted month-to-date spend ('¥3.20'), null when the site gives none */
export function accountMonthUsedText(usage: AccountUsage | null): string | null {
  return usage && typeof usage.monthUsedCny === 'number'
    ? `¥${usage.monthUsedCny.toFixed(2)}`
    : null
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
        code
          ? t(ACCOUNT_ERR_KEYS[`account:${code}` as AccountErrorCode])
          : t('accountErrFailed'),
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
