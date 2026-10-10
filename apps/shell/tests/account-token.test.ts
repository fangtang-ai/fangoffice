import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TokenSet } from '../src/main/auth-oidc'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  refresh: vi.fn<() => Promise<TokenSet>>(),
  write: vi.fn(),
  unlink: vi.fn(),
  stored: true,
  session: {
    userId: 'account-A',
    accessToken: 'expired-A',
    refreshToken: 'refresh-A',
    expiresAt: 0,
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => 'synthetic-profile', whenReady: () => new Promise<void>(() => {}) },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      fixture.handlers.set(name, handler),
  },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('node:fs', () => ({
  readFileSync: () => {
    if (!fixture.stored) throw new Error('no session')
    return JSON.stringify({ version: 1, plain: JSON.stringify(fixture.session) })
  },
  writeFileSync: fixture.write,
  unlinkSync: fixture.unlink,
}))

vi.mock('@genoffice/electron-utils', () => ({
  getAccountManagedDefaults: () => null,
  loadFangTangAccountConfig: () => ({
    accountApiBase: 'https://account.invalid',
    logtoEndpoint: 'https://login.invalid',
    logtoClientId: 'fixture',
    logtoApiResource: 'https://account.invalid',
  }),
  setAccountManagedDefaults: vi.fn(),
  setAccountManagedDefaultsPending: vi.fn(),
  setAccountManagedTokenProvider: vi.fn(),
}))

vi.mock('../src/main/auth-oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/auth-oidc')>()),
  refreshTokens: fixture.refresh,
}))

beforeEach(() => {
  vi.resetModules()
  fixture.handlers.clear()
  fixture.refresh.mockReset()
  fixture.write.mockClear()
  fixture.unlink.mockClear()
  fixture.stored = true
  fixture.unlink.mockImplementation(() => {
    fixture.stored = false
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { products: {} } }))),
  )
})

afterEach(() => vi.unstubAllGlobals())

it('coalesces concurrent account usage refreshes into one token exchange', async () => {
  let resolveRefresh!: (value: TokenSet) => void
  fixture.refresh.mockReturnValue(
    new Promise<TokenSet>((resolve) => {
      resolveRefresh = resolve
    }),
  )
  const { registerAccountIpc } = await import('../src/main/auth')
  registerAccountIpc()
  const getUsage = fixture.handlers.get('account:usage')!
  const requests = Array.from({ length: 5 }, () => getUsage())
  expect(fixture.refresh).toHaveBeenCalledTimes(1)
  resolveRefresh({ accessToken: 'renewed-A', expiresAt: Date.now() + 3600000 })
  await Promise.all(requests)
  expect(fixture.write).toHaveBeenCalledTimes(1)
})

it('does not resurrect or send a late token refresh after logout', async () => {
  let resolveRefresh!: (value: TokenSet) => void
  fixture.refresh.mockReturnValue(
    new Promise<TokenSet>((resolve) => {
      resolveRefresh = resolve
    }),
  )
  const { registerAccountIpc } = await import('../src/main/auth')
  registerAccountIpc()
  const request = fixture.handlers.get('account:usage')!()
  await fixture.handlers.get('account:logout')!()
  resolveRefresh({ accessToken: 'late-A', expiresAt: Date.now() + 3600000 })
  expect(await request).toBeNull()
  expect(fixture.handlers.get('account:session')!()).toEqual({ loggedIn: false })
  expect(fixture.write).not.toHaveBeenCalled()
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

it('provides main-only bound MCP access, reuses an already-renewed token and invalidates on logout', async () => {
  fixture.refresh.mockResolvedValue({ accessToken: 'renewed-A', expiresAt: Date.now() + 3600000 })
  const auth = await import('../src/main/auth')
  auth.registerAccountIpc()
  const access = auth.getAccountMcpAccess()
  const binding = access.bind()
  expect(binding.userId).toBe('account-A')
  expect(await access.token(binding)).toBe('renewed-A')
  expect(await access.token(binding, 'expired-A')).toBe('renewed-A')
  expect(fixture.refresh).toHaveBeenCalledTimes(1)
  const invalidated = vi.fn()
  const unsubscribe = access.subscribe!(invalidated)
  await fixture.handlers.get('account:logout')!()
  expect(binding.signal.aborted).toBe(true)
  expect(access.isCurrent(binding)).toBe(false)
  expect(invalidated).toHaveBeenCalledTimes(1)
  await expect(access.token(binding)).rejects.toThrow('account:changed')
  unsubscribe()
})

it('discards a previous account usage response arriving after logout', async () => {
  fixture.refresh.mockResolvedValue({ accessToken: 'renewed-A', expiresAt: Date.now() + 3600000 })
  let resolveResponse!: (value: Response) => void
  const network = vi.fn().mockReturnValue(
    new Promise<Response>((resolve) => {
      resolveResponse = resolve
    }),
  )
  vi.stubGlobal('fetch', network)
  const { registerAccountIpc } = await import('../src/main/auth')
  registerAccountIpc()
  const pending = fixture.handlers.get('account:usage')!()
  await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1))
  await fixture.handlers.get('account:logout')!()
  resolveResponse(
    new Response(JSON.stringify({ data: { products: { office_ai: { balanceCny: '99' } } } })),
  )
  expect(await pending).toBeNull()
})
