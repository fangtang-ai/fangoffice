import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setAccountManagedDefaults,
  setAccountManagedDefaultsLoader,
  setAccountManagedDefaultsPending,
  waitForAccountManagedDefaults,
} from '../src/account-defaults'

describe('account managed defaults loading', () => {
  afterEach(() => {
    setAccountManagedDefaults(null)
    setAccountManagedDefaultsLoader(null)
    setAccountManagedDefaultsPending(null)
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
  })
})
