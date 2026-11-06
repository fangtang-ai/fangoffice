import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setAccountManagedDefaults,
  setAccountManagedDefaultsLoader,
  setAccountManagedDefaultsPending,
  waitForAccountManagedDefaults,
  getAccountManagedSearchAccess,
  setAccountManagedTokenProvider,
  getFreshAccountManagedToken,
} from '../src/account-defaults'

describe('account managed defaults loading', () => {
  afterEach(() => {
    setAccountManagedDefaults(null)
    setAccountManagedDefaultsLoader(null)
    setAccountManagedDefaultsPending(null)
    setAccountManagedTokenProvider(null)
    vi.unstubAllEnvs()
  })

  it('waits for the existing account endpoint load without starting another one', async () => {
    let finishLoad: (() => void) | undefined
    const pendingLoad = new Promise<void>((resolve) => {
      finishLoad = resolve
    })
    setAccountManagedDefaultsPending(pendingLoad)

    let completed = false
    const waiting = waitForAccountManagedDefaults().then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    finishLoad?.()
    await waiting
    expect(completed).toBe(true)
  })

  it('only invokes the registered loader when no load or cached defaults exist', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    setAccountManagedDefaultsLoader(load)
    setAccountManagedDefaultsPending(Promise.resolve())
    await waitForAccountManagedDefaults()
    expect(load).not.toHaveBeenCalled()

    setAccountManagedDefaultsPending(null)
    await waitForAccountManagedDefaults()
    expect(load).toHaveBeenCalledTimes(1)

    setAccountManagedDefaults({ provider: 'fangtang' })
    await waitForAccountManagedDefaults()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('resolves with no loader in standalone editors', async () => {
    await expect(waitForAccountManagedDefaults()).resolves.toBeUndefined()
    expect(await getAccountManagedSearchAccess()).toBeUndefined()
  })

  it('uses the account API origin independently of AI wallet provisioning', async () => {
    vi.stubEnv('FANGTANG_ACCOUNT_API_BASE', 'https://test.fang-tang.cn')
    let token: string | null = 'test-account-token'
    setAccountManagedTokenProvider(() => token)
    expect(await getAccountManagedSearchAccess()).toEqual({
      url: 'https://test.fang-tang.cn/api/office/search',
      token,
    })
    token = 'refreshed-token'
    expect((await getAccountManagedSearchAccess())?.token).toBe(token)
    token = null
    expect((await getAccountManagedSearchAccess())?.token).toBe('')
  })

  it('rejects insecure account endpoints before disclosing an account token', async () => {
    vi.stubEnv('FANGTANG_ACCOUNT_API_BASE', 'http://example.com')
    setAccountManagedTokenProvider(() => 'test-token')
    await expect(getAccountManagedSearchAccess()).rejects.toThrow('secure endpoint')
  })

  it('uses the shell refresh hook for both AI and managed search instead of a stale token', async () => {
    vi.stubEnv('FANGTANG_ACCOUNT_API_BASE', 'https://test.fang-tang.cn')
    const refresh = vi.fn().mockResolvedValue('fresh-token')
    setAccountManagedTokenProvider(() => 'expired-token', refresh)
    expect(await getFreshAccountManagedToken()).toBe('fresh-token')
    expect((await getAccountManagedSearchAccess())?.token).toBe('fresh-token')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('never falls back to a stale token when account refresh fails', async () => {
    vi.stubEnv('FANGTANG_ACCOUNT_API_BASE', 'https://test.fang-tang.cn')
    setAccountManagedTokenProvider(
      () => 'expired-token',
      async () => {
        throw new Error('Login required')
      },
    )
    await expect(getAccountManagedSearchAccess()).rejects.toThrow('Login required')
    setAccountManagedTokenProvider(null)
    expect(await getFreshAccountManagedToken()).toBeNull()
  })
})
