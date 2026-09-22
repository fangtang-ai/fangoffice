/**
 * 方塘 account login (V1): Logto OIDC PKCE through the system browser with a
 * loopback HTTP callback, safeStorage-encrypted token persistence, and the
 * account-managed AI endpoint fetch that feeds the editors' settings merge.
 *
 * The shell registers the account:* IPC here; the pure OIDC logic lives in
 * auth-oidc.ts so it unit-tests without Electron.
 */

import { BrowserWindow, app, ipcMain, safeStorage, shell } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import {
  getAccountManagedDefaults,
  loadFangTangAccountConfig,
  setAccountManagedDefaults,
  setAccountManagedTokenProvider,
  type AccountManagedDefaults,
} from '@genoffice/electron-utils'
import type { AccountErrorCode, AccountUsage, AccountView } from '../shared/home-api'
import { HOME_CHANNELS } from '../shared/home-api'
import {
  accountDefaultsFromEndpoint,
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createAuthState,
  createPkcePair,
  exchangeCode,
  fetchAccountProfile,
  parseCallbackQuery,
  profileFromIdToken,
  refreshTokens,
  type AccountOidcConfig,
  type PkcePair,
  type TokenSet,
} from './auth-oidc'

export interface AccountSession {
  userId: string
  displayName?: string
  avatarUrl?: string
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** ms epoch when the access token goes stale */
  expiresAt: number
}

/** persisted shape: safeStorage ciphertext when available, plain JSON otherwise */
interface StoredAuth {
  version: 1
  encrypted?: string
  plain?: string
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** refresh the access token this long before its expiry */
const TOKEN_RENEW_MARGIN_MS = 60 * 1000

let session: AccountSession | null = null
let loginInFlight: Promise<AccountView> | null = null

/** a user-facing login failure with a stable code the renderer localizes */
class AccountError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code)
  }
}

function authStatePath(): string {
  return join(app.getPath('userData'), 'auth-state.json')
}

function loadSession(): AccountSession | null {
  try {
    const stored = JSON.parse(readFileSync(authStatePath(), 'utf8')) as StoredAuth
    const json =
      stored.encrypted !== undefined
        ? safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
        : stored.plain
    if (typeof json !== 'string') return null
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return null
    const s = parsed as AccountSession
    return typeof s.userId === 'string' && typeof s.accessToken === 'string' ? s : null
  } catch {
    return null // missing / unreadable / undecryptable: treat as signed out
  }
}

function saveSession(value: AccountSession | null): void {
  if (!value) {
    try {
      unlinkSync(authStatePath())
    } catch {
      // already absent: a second logout racing the first is fine
    }
    return
  }
  const stored: StoredAuth = { version: 1 }
  const json = JSON.stringify(value)
  // plaintext fallback when no OS keyring exists (bare Linux); the file is
  // still inside the user's own profile directory
  if (safeStorage.isEncryptionAvailable()) {
    stored.encrypted = safeStorage.encryptString(json).toString('base64')
  } else {
    stored.plain = json
  }
  writeFileSync(authStatePath(), JSON.stringify(stored), 'utf8')
}

function sessionView(value: AccountSession | null): AccountView {
  if (!value) return { loggedIn: false }
  return {
    loggedIn: true,
    userId: value.userId,
    displayName: value.displayName,
    avatarUrl: value.avatarUrl,
  }
}

function currentSession(): AccountSession | null {
  if (session === null) session = loadSession()
  return session
}

function broadcastSession(): void {
  const view = sessionView(currentSession())
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('account:session-changed', view)
  }
}

function requireAccountConfig(): AccountOidcConfig {
  const config = loadFangTangAccountConfig()
  if (!config.logtoEndpoint || !config.logtoClientId || !config.logtoApiResource) {
    throw new AccountError('account:not-configured')
  }
  return {
    logtoEndpoint: config.logtoEndpoint,
    clientId: config.logtoClientId,
    apiResource: config.logtoApiResource,
  }
}

/** persist + adopt a new token set, keeping the existing profile fields */
function adoptTokens(tokens: TokenSet, profile?: Partial<AccountSession>): AccountSession {
  const existing = currentSession()
  const next: AccountSession = {
    userId: profile?.userId ?? existing?.userId ?? '',
    displayName: profile?.displayName ?? existing?.displayName,
    avatarUrl: profile?.avatarUrl ?? existing?.avatarUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? existing?.refreshToken,
    idToken: tokens.idToken ?? existing?.idToken,
    expiresAt: tokens.expiresAt,
  }
  session = next
  saveSession(next)
  return next
}

function clearSession(): void {
  session = null
  saveSession(null)
  if (getAccountManagedDefaults()) setAccountManagedDefaults(null)
}

/**
 * Exchange the refresh token when the access token is stale. An invalid_grant
 * (revoked session / expired refresh token) signs the user out; network
 * failures keep the session so an offline start doesn't log anyone out.
 */
async function validAccessToken(): Promise<string> {
  const current = currentSession()
  if (!current) throw new AccountError('account:not-configured')
  if (current.expiresAt - Date.now() > TOKEN_RENEW_MARGIN_MS) return current.accessToken
  if (!current.refreshToken) throw new AccountError('account:expired')
  try {
    const tokens = await refreshTokens(requireAccountConfig(), current.refreshToken)
    return adoptTokens(tokens).accessToken
  } catch (error) {
    if (error instanceof Error && error.message.includes('invalid_grant')) {
      clearSession()
      broadcastSession()
      throw new AccountError('account:expired')
    }
    throw new AccountError('account:failed')
  }
}

/** loopback callback: resolve { code, redirectUri } once the browser comes back */
/** registered in the Logto tenant's 方塘Office app; keep in sync there */
const LOGIN_LOOPBACK_PORTS = [5731, 5732]

function awaitAuthorizationCode(
  config: AccountOidcConfig,
): Promise<{ code: string; redirectUri: string; pkce: PkcePair }> {
  return new Promise((resolve, reject) => {
    const pkce = createPkcePair()
    const state = createAuthState()
    const settle = (error: AccountError | undefined, code?: string) => {
      clearTimeout(timer)
      server.close()
      if (error) reject(error)
      else resolve({ code: code!, redirectUri, pkce })
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const result = parseCallbackQuery(url.search)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (result.error) {
        res.end(LOGIN_FAILURE_PAGE)
        settle(
          new AccountError(result.error === 'access_denied' ? 'account:canceled' : 'account:failed'),
        )
        return
      }
      if (result.state !== state || !result.code) {
        res.end(LOGIN_FAILURE_PAGE)
        settle(new AccountError('account:failed'))
        return
      }
      res.end(LOGIN_SUCCESS_PAGE)
      settle(undefined, result.code)
    })
    let redirectUri = ''
    const timer = setTimeout(() => settle(new AccountError('account:timeout')), LOGIN_TIMEOUT_MS)
    // Logto matches redirect URIs exactly (no wildcard/any-port), so the port is
    // fixed and must stay in sync with the app's registered redirect URIs in
    // the Logto tenant (5731 primary, 5732 fallback if 5731 is occupied).
    const tryListen = (ports: number[]) => {
      if (ports.length === 0) {
        settle(new AccountError('account:failed'))
        return
      }
      const port = ports[0]!
      server.once('error', () => {
        server.removeAllListeners('error')
        tryListen(ports.slice(1))
      })
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        redirectUri = `http://127.0.0.1:${port}/callback`
        const authorizeUrl = buildAuthorizeUrl(config, redirectUri, pkce, state)
        shell.openExternal(authorizeUrl).catch(() => settle(new AccountError('account:failed')))
      })
    }
    tryListen(LOGIN_LOOPBACK_PORTS)
  })
}

const LOGIN_SUCCESS_PAGE =
  '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:20vh">' +
  '<h2>登录成功</h2><p>请回到方塘Office继续使用。</p></body>'
const LOGIN_FAILURE_PAGE =
  '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:20vh">' +
  '<h2>登录未完成</h2><p>请回到方塘Office重试。</p></body>'

async function performLogin(): Promise<AccountSession> {
  const config = requireAccountConfig()
  const { code, redirectUri, pkce } = await awaitAuthorizationCode(config)
  const tokens = await exchangeCode(config, code, redirectUri, pkce.verifier)
  // /oidc/me rejects resource-JWTs (401), so prefer the ID token's own claims;
  // only fall back to /oidc/me when no ID token was minted
  const profile = profileFromIdToken(tokens.idToken) ??
    (await fetchAccountProfile(config.logtoEndpoint, tokens.accessToken))
  return adoptTokens(tokens, profile)
}

/**
 * After login/startup-refresh: pull the managed AI endpoint from the site and
 * register it as the account defaults layer. A missing site module (V1
 * pre-S3) or a transient failure leaves the account layer unset instead of
 * failing the login.
 */
async function applyAccountAiEndpoint(): Promise<void> {
  const current = currentSession()
  const config = loadFangTangAccountConfig()
  let next: AccountManagedDefaults | null = null
  if (current && config.accountApiBase) {
    try {
      const response = await fetch(new URL('/api/office/ai-endpoint', config.accountApiBase), {
        headers: { Authorization: `Bearer ${current.accessToken}` },
      })
      if (response.ok) {
        const body: unknown = await response.json().catch(() => null)
        next = accountDefaultsFromEndpoint(body as { baseUrl?: unknown } | null)
      }
    } catch {
      // offline / module not deployed yet: keep whatever layer is registered
    }
  }
  const previous = getAccountManagedDefaults()
  if (!previous && !next) return
  const changed = JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null)
  setAccountManagedDefaults(next)
  if (changed) broadcastSession()
}

export function registerAccountIpc(): void {
  // the fangtang billing proxy authenticates with the user's live Logto access
  // token; the ai:stream handlers (docs bundle, same process) read it per request
  setAccountManagedTokenProvider(() => currentSession()?.accessToken ?? null)

  ipcMain.handle(HOME_CHANNELS.getAccountSession, (): AccountView => sessionView(currentSession()))

  ipcMain.handle(HOME_CHANNELS.loginAccount, async (): Promise<AccountView> => {
    if (loginInFlight) return loginInFlight
    loginInFlight = (async () => {
      try {
        const next = await performLogin()
        void applyAccountAiEndpoint().then(broadcastSession)
        return sessionView(next)
      } catch (error) {
        throw error instanceof AccountError ? error : new AccountError('account:failed')
      } finally {
        loginInFlight = null
      }
    })()
    return loginInFlight
  })

  ipcMain.handle(HOME_CHANNELS.logoutAccount, async (): Promise<void> => {
    const current = currentSession()
    clearSession()
    broadcastSession()
    const endpoint = loadFangTangAccountConfig().logtoEndpoint
    if (endpoint) {
      // best-effort: sign the browser SSO session out too (its cookie lives there)
      shell.openExternal(buildEndSessionUrl(endpoint, current?.idToken)).catch(() => undefined)
    }
  })

  ipcMain.handle(HOME_CHANNELS.getAccountUsage, async (): Promise<AccountUsage | null> => {
    const current = currentSession()
    const apiBase = loadFangTangAccountConfig().accountApiBase
    if (!current || !apiBase) return null
    try {
      const accessToken = await validAccessToken()
      // 站点 /api/office/account 返回 balanceCny/monthChargedCny 等；renderer 读 balanceCny + monthUsedCny
      const response = await fetch(new URL('/api/office/account', apiBase), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!response.ok) return null
      const body: unknown = await response.json()
      // 站点响应包在 { success, code, data } 里,取 data
      const payload =
        body && typeof body === 'object' ? (body as { data?: unknown }).data : null
      const account =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null
      if (!account) return null
      return { ...account, monthUsedCny: account.monthChargedCny }
    } catch {
      return null
    }
  })

  ipcMain.handle(HOME_CHANNELS.openRecharge, (): void => {
    const rechargeUrl = loadFangTangAccountConfig().rechargeUrl
    shell.openExternal(rechargeUrl || 'https://fang-tang.cn').catch(() => undefined)
  })

  // restore a persisted session; silently refresh + re-provision the AI
  // endpoint when a refresh token is at hand. Failures stay silent — the
  // renderer just sees last-known state and retry happens on next use.
  if (existsSync(authStatePath()) && currentSession()?.refreshToken) {
    void validAccessToken()
      .then(() => applyAccountAiEndpoint())
      .then(broadcastSession)
      .catch(() => undefined)
  }
}
