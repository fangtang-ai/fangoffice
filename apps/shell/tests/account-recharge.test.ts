import { describe, expect, it } from 'vitest'
import type { AccountView } from '../src/shared/home-api'
import { accountRechargeUrl, rechargeMismatchView } from '../src/main/account-recharge'

const view = (userId: string | undefined): AccountView =>
  userId === undefined ? { loggedIn: false } : { loggedIn: true, userId }

it.each(['https://test.fang-tang.cn', 'https://fang-tang.cn'])(
  'preserves %s and binds knowledge recharge to the desktop account',
  (origin) => {
    const url = new URL(
      accountRechargeUrl(
        `${origin}/account/office-recharge`,
        'knowledge_base',
        'office-test-subject',
      ),
    )
    expect(url.origin).toBe(origin)
    expect(url.pathname).toBe('/account/office-recharge')
    expect(url.searchParams.get('product')).toBe('knowledge_base')
    expect(url.searchParams.get('accountId')).toBe('office-test-subject')
  },
)

describe('rechargeMismatchView', () => {
  it('passes the view through when no recharge was opened', () => {
    const account = view('account-A')
    expect(rechargeMismatchView(account, null)).toEqual({ view: account, openedUserId: null })
  })

  it('clears the record when the same user returns, without a flag', () => {
    const account = view('account-A')
    expect(rechargeMismatchView(account, 'account-A')).toEqual({
      view: account,
      openedUserId: null,
    })
    expect(account.rechargeAccountChanged).toBeUndefined()
  })

  it('flags one-shot when the session resolves to a different user', () => {
    const account = view('account-B')
    const result = rechargeMismatchView(account, 'account-A')
    expect(result.view.rechargeAccountChanged).toBe(true)
    expect(result.openedUserId).toBeNull()
  })

  it('keeps watching across logged-out views so the next login is still checked', () => {
    const loggedOut = view(undefined)
    expect(rechargeMismatchView(loggedOut, 'account-A')).toEqual({
      view: loggedOut,
      openedUserId: 'account-A',
    })
    const next = rechargeMismatchView(view('account-B'), 'account-A')
    expect(next.view.rechargeAccountChanged).toBe(true)
    expect(next.openedUserId).toBeNull()
  })

  it('stays silent when a fresh session exists without any recharge record', () => {
    const account = view('account-C')
    expect(rechargeMismatchView(account, null).view.rechargeAccountChanged).toBeUndefined()
  })
})
