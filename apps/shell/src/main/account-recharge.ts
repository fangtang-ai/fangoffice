import type { AccountView } from '../shared/home-api'

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
