import type { AccountView, OfficeRechargeProduct } from '../shared/home-api'

export function accountRechargeUrl(
  configuredUrl: string | undefined,
  product: OfficeRechargeProduct,
  userId?: string,
) {
  if (product !== 'office_ai' && product !== 'policy_mcp' && product !== 'knowledge_base') {
    throw new Error('Invalid billing product')
  }
  const url = new URL(configuredUrl || 'https://fang-tang.cn/account/office-recharge')
  const localHttp =
    url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password) {
    throw new Error('Invalid recharge URL')
  }
  // The website uses accountId only to warn about a different signed-in user; it never grants access.
  url.searchParams.set('product', product)
  url.searchParams.delete('accountId')
  if (userId) url.searchParams.set('accountId', userId)
  return url.href
}

/**
 * One-shot recharge account check. While a recharge is open under user A, a
 * session that later resolves to user B means the wallet the UI is about to
 * show belongs to a different account — the view gets a transient flag, and
 * the record is consumed so it never fires twice. Logged-out views keep the
 * record so the next login (either user) is still checked.
 */
export function rechargeMismatchView(
  view: AccountView,
  openedUserId: string | null,
): { view: AccountView; openedUserId: string | null } {
  if (openedUserId === null) return { view, openedUserId }
  if (view.loggedIn && view.userId === openedUserId) return { view, openedUserId: null }
  if (view.loggedIn) return { view: { ...view, rechargeAccountChanged: true }, openedUserId: null }
  return { view, openedUserId }
}
