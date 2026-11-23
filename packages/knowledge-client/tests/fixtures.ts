import { vi } from 'vitest'
import type { KnowledgeAccountAccess } from '../src'

export const spaceId = '019a1234-0000-7000-8000-000000000001'
export const space = { id: spaceId, title: '合成空间', state: 'active' }
export const page = { items: [space], nextCursor: null }

export function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

export function fixtureAccount() {
  let userId = 'synthetic-account-A'
  let sessionId = 1
  let controller = new AbortController()
  const token = vi.fn<KnowledgeAccountAccess['token']>(async (binding, rejected) =>
    binding.userId.endsWith('B')
      ? 'synthetic-token-B'
      : rejected
        ? 'synthetic-renewed-token-A'
        : 'synthetic-token-A',
  )
  const access: KnowledgeAccountAccess = {
    apiBase: () => 'https://account.invalid',
    knowledgeBase: () => 'https://account.invalid/api/knowledge',
    bind: () => ({ userId, sessionId, signal: controller.signal }),
    isCurrent: (binding) => binding.userId === userId && binding.sessionId === sessionId,
    token,
  }
  const switchAccount = () => {
    controller.abort()
    controller = new AbortController()
    userId = 'synthetic-account-B'
    sessionId += 1
  }
  return { access, token, switchAccount }
}

export async function settlesSoon<Value>(promise: Promise<Value>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<'still-pending'>((resolve) => {
        timer = setTimeout(() => resolve('still-pending'), 50)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
