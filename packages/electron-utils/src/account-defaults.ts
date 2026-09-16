/**
 * Module-level registration point for the account-managed AI endpoint (V1:
 * endpoint + key delivered once the user logs into the shell). The shell's
 * auth module calls setAccountManagedDefaults() on login / logout / token
 * refresh; the ai:get-settings merge points read it via
 * getAccountManagedDefaults().
 *
 * Lives here — not in the shell — because the shell-aggregate registers the
 * AI IPC from the docs main bundle in the same process, so a shared
 * singleton in electron-utils is visible to both without a cross-app import.
 * Editors running standalone (outside the shell) never see a registration
 * and keep their current factory-defaults behavior.
 *
 * Same shape as @genoffice/ai-provider's AiFactoryDefaults (the account
 * layer folds over the factory layer), declared structurally here to avoid
 * an electron-utils → ai-provider dependency.
 */
export interface AccountManagedDefaults {
  provider?: string
  apiKey?: string
  baseUrl?: string
  model?: string
  maxOutputTokens?: number
}

let current: AccountManagedDefaults | null = null

export function setAccountManagedDefaults(value: AccountManagedDefaults | null): void {
  current = value
}

export function getAccountManagedDefaults(): AccountManagedDefaults | null {
  return current
}
