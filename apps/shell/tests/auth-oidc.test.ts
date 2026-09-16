/**
 * Unit tests for the pure Logto OIDC helpers (auth-oidc.ts) — no Electron.
 * fetch is stubbed so the token/me round trips run in-process.
 */

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountDefaultsFromEndpoint,
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createPkcePair,
  exchangeCode,
  fetchAccountProfile,
  parseCallbackQuery,
  refreshTokens,
  tokenSetFromResponse,
  type AccountOidcConfig,
} from '../src/main/auth-oidc'

const CONFIG: AccountOidcConfig = {
  logtoEndpoint: 'https://logto.example.com',
  clientId: 'client-1',
  apiResource: 'https://api.example.com/office',
}

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

afterEach(() => {
  fetchMock.mockReset()
})

describe('createPkcePair', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier.length).toBeGreaterThan(40)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })
})

describe('buildAuthorizeUrl', () => {
  it('carries the PKCE + offline_access requirements', () => {
    const url = new URL(
      buildAuthorizeUrl(CONFIG, 'http://127.0.0.1:1/callback', createPkcePair(), 'st-1'),
    )
    expect(url.origin + url.pathname).toBe('https://logto.example.com/oidc/auth')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1/callback')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('resource')).toBe(CONFIG.apiResource)
    expect(url.searchParams.get('prompt')).toBe('consent')
  })
})

describe('buildEndSessionUrl', () => {
  it('adds the id_token_hint when available', () => {
    expect(buildEndSessionUrl(CONFIG.logtoEndpoint).toString()).toBe(
      'https://logto.example.com/oidc/session/end',
    )
    const withToken = new URL(buildEndSessionUrl(CONFIG.logtoEndpoint, 'idt-1'))
    expect(withToken.searchParams.get('id_token_hint')).toBe('idt-1')
  })
})

describe('parseCallbackQuery', () => {
  it('reads code + state', () => {
    expect(parseCallbackQuery('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })
  it('returns errors as data', () => {
    expect(parseCallbackQuery('?error=access_denied&error_description=nope')).toEqual({
      error: 'access_denied',
      errorDescription: 'nope',
    })
  })
  it('treats an empty code as absent', () => {
    expect(parseCallbackQuery('?state=xyz').code).toBeUndefined()
  })
})

describe('tokenSetFromResponse', () => {
  it('computes expiresAt from expires_in', () => {
    const set = tokenSetFromResponse(
      { access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 600 },
      1_000,
    )
    expect(set).toEqual({ accessToken: 'at', refreshToken: 'rt', idToken: 'it', expiresAt: 601_000 })
  })
  it('rejects responses without an access_token', () => {
    expect(() => tokenSetFromResponse({ error: 'x' })).toThrow('access_token')
  })
  it('defaults expiresAt to the issue time without expires_in', () => {
    expect(tokenSetFromResponse({ access_token: 'at' }, 5_000).expiresAt).toBe(5_000)
  })
})

describe('token endpoints', () => {
  it('sends the PKCE exchange form to /oidc/token', async () => {
    vi.mocked(fetchMock).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 300 })),
    )
    const set = await exchangeCode(CONFIG, 'code-1', 'http://127.0.0.1:1/callback', 'ver-1')
    expect(set.accessToken).toBe('at')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ]
    expect(url.origin + url.pathname).toBe('https://logto.example.com/oidc/token')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('code-1')
    expect(form.get('code_verifier')).toBe('ver-1')
    expect(form.get('client_id')).toBe('client-1')
  })

  it('sends the refresh grant and surfaces invalid_grant', async () => {
    vi.mocked(fetchMock).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 60 })),
    )
    const set = await refreshTokens(CONFIG, 'rt-old')
    expect(set.refreshToken).toBe('rt2')
    const form = new URLSearchParams(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('rt-old')

    vi.mocked(fetchMock).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    )
    await expect(refreshTokens(CONFIG, 'rt-bad')).rejects.toThrow('invalid_grant')
  })
})

describe('fetchAccountProfile', () => {
  it('maps the /oidc/me claims', async () => {
    vi.mocked(fetchMock).mockResolvedValueOnce(
      new Response(JSON.stringify({ sub: 'u-1', name: '张三', picture: 'https://a/b.png' })),
    )
    const profile = await fetchAccountProfile(CONFIG.logtoEndpoint, 'at')
    expect(profile).toEqual({ userId: 'u-1', displayName: '张三', avatarUrl: 'https://a/b.png' })
    expect((fetchMock.mock.calls[0]![0] as URL).pathname).toBe('/oidc/me')
  })
  it('requires sub', async () => {
    vi.mocked(fetchMock).mockResolvedValueOnce(new Response(JSON.stringify({ name: 'x' })))
    await expect(fetchAccountProfile(CONFIG.logtoEndpoint, 'at')).rejects.toThrow('sub')
  })
  it('rejects non-2xx replies', async () => {
    vi.mocked(fetchMock).mockResolvedValueOnce(new Response('nope', { status: 401 }))
    await expect(fetchAccountProfile(CONFIG.logtoEndpoint, 'bad')).rejects.toThrow('401')
  })
})

describe('accountDefaultsFromEndpoint', () => {
  it('maps a complete reply to the custom-provider account layer', () => {
    expect(accountDefaultsFromEndpoint({ baseUrl: 'https://api/v1', apiKey: 'sk', model: 'gpt-x' })).toEqual({
      provider: 'custom',
      baseUrl: 'https://api/v1',
      apiKey: 'sk',
      model: 'gpt-x',
    })
  })
  it('keeps an incomplete reply as no account layer', () => {
    expect(accountDefaultsFromEndpoint({ baseUrl: 'https://api/v1' })).toBeNull()
    expect(accountDefaultsFromEndpoint(null)).toBeNull()
  })
})
