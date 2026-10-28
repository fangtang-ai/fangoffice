import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TokenSet } from '../src/main/auth-oidc'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  refresh: vi.fn<() => Promise<TokenSet>>(),
  network: vi.fn<typeof fetch>(),
  outcomes: [] as string[],
  stored: true,
  session: {
    userId: 'synthetic-account',
    accessToken: 'synthetic-expired-token',
    refreshToken: 'synthetic-refresh-token',
    expiresAt: 0,
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => 'synthetic-no-profile', whenReady: () => Promise.resolve() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      fixture.handlers.set(name, handler),
  },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('node:fs', () => ({
  readFileSync: () => {
    if (!fixture.stored) throw new Error('no synthetic session')
    return JSON.stringify({ version: 1, plain: JSON.stringify(fixture.session) })
  },
  writeFileSync: vi.fn(),
  unlinkSync: () => {
    fixture.stored = false
  },
}))

vi.mock('node:fs/promises', () => ({
  appendFile: async (_path: string, line: string) => {
    fixture.outcomes.push(line)
  },
}))

vi.mock('../src/main/auth-oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/auth-oidc')>()),
  refreshTokens: fixture.refresh,
}))

beforeEach(async () => {
  vi.resetModules()
  fixture.handlers.clear()
  fixture.refresh.mockReset()
  fixture.network.mockReset()
  fixture.outcomes = []
  fixture.stored = true
  fixture.session.expiresAt = 0
  const defaults = await import('../../../packages/electron-utils/src/account-defaults')
  vi.doMock('@genoffice/electron-utils', () => ({
    ...defaults,
    loadFangTangAccountConfig: () => ({
      accountApiBase: 'https://synthetic.invalid',
      logtoEndpoint: 'https://synthetic-login.invalid',
      logtoClientId: 'synthetic-client',
      logtoApiResource: 'https://synthetic.invalid',
    }),
  }))
  fixture.refresh.mockResolvedValue({
    accessToken: 'synthetic-fresh-token',
    expiresAt: Date.now() + 3_600_000,
  })
  fixture.network.mockImplementation(
    async (address) =>
      new Response(
        JSON.stringify({
          data:
            new URL(String(address)).pathname === '/api/office/ai-endpoint'
              ? {
                  provider: 'fangtang',
                  baseUrl: 'https://synthetic.invalid/api/office/ai/chat',
                  model: 'glm-5.3-flash',
                }
              : { products: {} },
        }),
      ),
  )
  vi.stubGlobal('fetch', fixture.network)
})

afterEach(() => vi.unstubAllGlobals())

async function startAccount() {
  const defaults = await import('../../../packages/electron-utils/src/account-defaults')
  const auth = await import('../src/main/auth')
  auth.registerAccountIpc()
  await defaults.waitForAccountManagedDefaults()
  return defaults
}

it('recovers the account AI endpoint when usage succeeds after startup token refresh failed', async () => {
  fixture.refresh.mockRejectedValueOnce(new Error('synthetic transient failure'))
  const defaults = await startAccount()
  expect(fixture.outcomes.some((line) => line.includes('restore-failed'))).toBe(true)
  expect(fixture.handlers.get('account:session')!()).toMatchObject({ loggedIn: true })
  expect(defaults.getAccountManagedDefaults()).toBeNull()

  await fixture.handlers.get('account:usage')!()

  expect(fixture.refresh).toHaveBeenCalledTimes(2)
  await vi.waitFor(() =>
    expect(defaults.getAccountManagedDefaults()).toMatchObject({
      provider: 'fangtang',
      model: 'glm-5.3-flash',
    }),
  )
})

it('retries a failed startup restore on the next AI request without requiring a balance refresh', async () => {
  fixture.refresh.mockRejectedValueOnce(new Error('synthetic transient failure'))
  const defaults = await startAccount()
  expect(defaults.getAccountManagedDefaults()).toBeNull()

  await defaults.waitForAccountManagedDefaults()

  expect(fixture.refresh).toHaveBeenCalledTimes(2)
  expect(defaults.getAccountManagedDefaults()).toMatchObject({ provider: 'fangtang' })
})

it.each(['transport', 'http-503', 'invalid-response'])(
  'recovers from a startup endpoint %s failure with a still-valid access token',
  async (failure) => {
    fixture.session.expiresAt = Date.now() + 3_600_000
    if (failure === 'transport') {
      fixture.network.mockRejectedValueOnce(new Error('synthetic transport failure'))
    } else {
      fixture.network.mockResolvedValueOnce(
        new Response('{}', { status: failure === 'http-503' ? 503 : 200 }),
      )
    }
    const defaults = await startAccount()
    expect(defaults.getAccountManagedDefaults()).toBeNull()
    expect(fixture.network).toHaveBeenCalledTimes(1)

    await defaults.waitForAccountManagedDefaults()

    expect(fixture.refresh).not.toHaveBeenCalled()
    expect(fixture.network).toHaveBeenCalledTimes(2)
    expect(defaults.getAccountManagedDefaults()).toMatchObject({ provider: 'fangtang' })
  },
)

it('coalesces concurrent AI recovery requests and reuses the successful endpoint', async () => {
  fixture.refresh.mockRejectedValueOnce(new Error('synthetic transient failure'))
  const defaults = await startAccount()
  let finishLoad!: (response: Response) => void
  fixture.network.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      finishLoad = resolve
    }),
  )

  const requests = Array.from({ length: 5 }, () => defaults.waitForAccountManagedDefaults())
  await vi.waitFor(() => expect(fixture.network).toHaveBeenCalledTimes(1))
  expect(defaults.getAccountManagedDefaults()).toBeNull()
  finishLoad(
    new Response(
      JSON.stringify({ data: { provider: 'fangtang', baseUrl: 'https://synthetic.invalid/v1' } }),
    ),
  )
  await Promise.all(requests)
  await defaults.waitForAccountManagedDefaults()
  await fixture.handlers.get('account:usage')!()

  expect(defaults.getAccountManagedDefaults()).toMatchObject({ provider: 'fangtang' })
  expect(fixture.network).toHaveBeenCalledTimes(2)
  expect(fixture.network.mock.calls[0]?.[1]).toMatchObject({
    headers: { Authorization: 'Bearer synthetic-fresh-token' },
    redirect: 'error',
  })
})

it('discards a late recovery response after logout and does not request again while signed out', async () => {
  fixture.refresh.mockRejectedValueOnce(new Error('synthetic transient failure'))
  const defaults = await startAccount()
  let finishLoad!: (response: Response) => void
  fixture.network.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      finishLoad = resolve
    }),
  )
  const request = defaults.waitForAccountManagedDefaults()
  await vi.waitFor(() => expect(fixture.network).toHaveBeenCalledTimes(1))

  await fixture.handlers.get('account:logout')!()
  finishLoad(
    new Response(
      JSON.stringify({ data: { provider: 'fangtang', baseUrl: 'https://synthetic.invalid/v1' } }),
    ),
  )
  await request
  await defaults.waitForAccountManagedDefaults()

  expect(defaults.getAccountManagedDefaults()).toBeNull()
  expect(defaults.getAccountManagedToken()).toBeNull()
  expect(fixture.handlers.get('account:session')!()).toEqual({ loggedIn: false })
  expect(fixture.network.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  expect(fixture.network).toHaveBeenCalledTimes(1)
})

it('keeps login usable during repeated endpoint failures and only retries on demand', async () => {
  fixture.network.mockRejectedValue(new Error('synthetic offline endpoint'))
  const defaults = await startAccount()
  expect(fixture.network).toHaveBeenCalledTimes(1)

  await defaults.waitForAccountManagedDefaults()

  expect(fixture.network).toHaveBeenCalledTimes(2)
  expect(defaults.getAccountManagedDefaults()).toBeNull()
  expect(fixture.handlers.get('account:session')!()).toMatchObject({ loggedIn: true })
})
