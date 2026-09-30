import { afterEach, describe, expect, it } from 'vitest'
import {
  setAccountManagedDefaultsPending,
  waitForAccountManagedDefaults,
} from '../src/account-defaults'

describe('account managed defaults loading', () => {
  afterEach(() => setAccountManagedDefaultsPending(null))

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
})
