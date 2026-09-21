/**
 * Pure Logto OIDC helpers for the desktop login (no electron imports, so the
 * logic unit-tests without an Electron runtime). Flow: system browser opens
 * the authorize URL (PKCE S256) → loopback HTTP callback receives the code →
 * code/token exchange → refresh-token silent renewal. Endpoints follow the
 * standard OIDC paths Logto serves under /oidc/*.
 */

import { createHash, randomBytes } from 'node:crypto'

/** PKCE pair; the verifier is sent to the token endpoint, the challenge to /oidc/auth */
export interface PkcePair {
  verifier: string
  challenge: string
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** opaque anti-forgery state for the authorize redirect */
export function createAuthState(): string {
  return randomBytes(16).toString('base64url')
}

/** account deployment config (subset of FangTangAccountConfig required for login) */
export interface AccountOidcConfig {
  logtoEndpoint: string
  clientId: string
  /** access tokens are minted for this API resource (audience) */
  apiResource: string
}

/**
 * Build the authorization redirect. `prompt=consent` is required by Logto to
 * hand out refresh tokens (together with the offline_access scope).
 */
export function buildAuthorizeUrl(
  config: AccountOidcConfig,
  redirectUri: string,
  pkce: PkcePair,
  state: string,
): string {
  const url = new URL('/oidc/auth', config.logtoEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', 'openid profile offline_access')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('resource', config.apiResource)
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

/** Logto's front-channel sign-out; the browser holds the SSO cookie */
export function buildEndSessionUrl(logtoEndpoint: string, idToken?: string): string {
  const url = new URL('/oidc/session/end', logtoEndpoint)
  if (idToken) url.searchParams.set('id_token_hint', idToken)
  return url.toString()
}

export interface CallbackResult {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}

/** read the loopback callback query; returns error as data so callers can show it */
export function parseCallbackQuery(search: string): CallbackResult {
  const query = new URLSearchParams(search)
  const error = query.get('error') ?? undefined
  const code = query.get('code') ?? undefined
  if (error) return { error, errorDescription: query.get('error_description') ?? undefined }
  return { code: code || undefined, state: query.get('state') ?? undefined }
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** ms epoch when the access token goes stale (refresh a minute before) */
  expiresAt: number
}

/** map an OIDC token response to the persisted shape */
export function tokenSetFromResponse(
  body: Record<string, unknown>,
  issuedAtMs = Date.now(),
): TokenSet {
  const accessToken = body.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('token response missing access_token')
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    expiresAt: issuedAtMs + expiresIn * 1000,
  }
}

export interface AccountProfile {
  userId: string
  displayName?: string
  avatarUrl?: string
}

function tokenError(body: unknown, status: number): Error {
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
  // prefer error_description, then the bare error code (spec-minimum replies
  // only set `error` — auth.ts keys its sign-out-on-invalid_grant off this)
  const description =
    typeof fields?.error_description === 'string' && fields.error_description
      ? fields.error_description
      : typeof fields?.error === 'string' && fields.error
        ? fields.error
        : `token endpoint returned HTTP ${status}`
  return new Error(description)
}

async function postTokenForm(
  config: AccountOidcConfig,
  form: Record<string, string>,
): Promise<TokenSet> {
  const response = await fetch(new URL('/oidc/token', config.logtoEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !body || typeof body !== 'object') {
    throw tokenError(body, response.status)
  }
  return tokenSetFromResponse(body as Record<string, unknown>)
}

/** authorization-code + PKCE exchange on the loopback callback */
export async function exchangeCode(
  config: AccountOidcConfig,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenSet> {
  return postTokenForm(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  })
}

/** silent renewal; a revoked/expired refresh token surfaces as invalid_grant */
export async function refreshTokens(
  config: AccountOidcConfig,
  refreshToken: string,
): Promise<TokenSet> {
  return postTokenForm(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  })
}

/** GET /oidc/me — the ID-token claims of the freshly minted access token */
export async function fetchAccountProfile(
  logtoEndpoint: string,
  accessToken: string,
): Promise<AccountProfile> {
  const response = await fetch(new URL('/oidc/me', logtoEndpoint), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error(`oidc/me returned HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object') throw new Error('oidc/me returned no JSON object')
  const claims = body as Record<string, unknown>
  if (typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('oidc/me response missing sub')
  }
  return {
    userId: claims.sub,
    displayName: typeof claims.name === 'string' ? claims.name : undefined,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
  }
}

export interface OfficeEndpointReply {
  data?: unknown
  provider?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  model?: unknown
}

/**
 * Map the site's GET /api/office/ai-endpoint reply to the account-managed
 * defaults layer. `provider: 'fangtang'` selects the site's billing proxy —
 * it carries no static key, every request rides the user's live Logto access
 * token (see getAccountManagedToken). Any other shape maps to the legacy
 * OpenAI-compatible custom provider behind New API. Incomplete replies yield
 * null — the account layer is then simply absent and the editors keep
 * running on factory defaults / BYOK.
 */
export function accountDefaultsFromEndpoint(
  reply: OfficeEndpointReply | null | undefined,
): { provider: 'custom' | 'fangtang'; baseUrl: string; apiKey: string; model?: string } | null {
  // ApiResDto.success wraps the payload as {data: …}; tolerate the bare shape too
  const payload =
    reply && typeof reply === 'object' && reply.data && typeof reply.data === 'object'
      ? (reply.data as OfficeEndpointReply)
      : reply
  if (!payload || typeof payload !== 'object') return null
  const { provider, baseUrl, apiKey, model } = payload
  if (typeof baseUrl !== 'string' || !baseUrl) return null
  if (provider === 'fangtang') {
    return {
      provider: 'fangtang',
      baseUrl,
      apiKey: '',
      ...(typeof model === 'string' && model ? { model } : {}),
    }
  }
  if (typeof apiKey !== 'string' || !apiKey) return null
  return {
    provider: 'custom',
    baseUrl,
    apiKey,
    ...(typeof model === 'string' && model ? { model } : {}),
  }
}
