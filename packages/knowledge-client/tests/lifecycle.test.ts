import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeClient } from '../src'
import { deferred, fixtureAccount, page, settlesSoon } from './fixtures'

afterEach(() => vi.restoreAllMocks())

it('uses a new binding and token after account switch instead of sharing old request state', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(page))
  const { access, switchAccount } = fixtureAccount()
  const client = createKnowledgeClient(access)
  await client.listSpaces()
  switchAccount()
  await client.listSpaces()
  expect(new Headers(network.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
    'Bearer synthetic-token-B',
  )
})

it('cancels a hung response body and never publishes the late JSON', async () => {
  const pending = deferred<unknown>()
  const response = Response.json(page)
  vi.spyOn(response, 'json').mockReturnValue(pending.promise)
  const cancel = vi.spyOn(response.body!, 'cancel')
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
  const { access, switchAccount } = fixtureAccount()
  const request = createKnowledgeClient(access)
    .listSpaces()
    .catch((error: unknown) => error)
  await vi.waitFor(() => expect(response.json).toHaveBeenCalledOnce())
  switchAccount()
  try {
    expect(await settlesSoon(request)).toMatchObject({ code: 'knowledge:account-changed' })
  } finally {
    pending.resolve(page)
    await request
  }
  expect(cancel).toHaveBeenCalledOnce()
})

it('closes an in-flight request without waiting for an uncooperative network adapter', async () => {
  const pending = deferred<Response>()
  const network = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise)
  const { access } = fixtureAccount()
  const client = createKnowledgeClient(access)
  const request = client.listSpaces().catch((error: unknown) => error)
  await vi.waitFor(() => expect(network).toHaveBeenCalledOnce())
  client.close()
  try {
    expect(await settlesSoon(request)).toMatchObject({ code: 'knowledge:closed' })
  } finally {
    pending.resolve(Response.json(page))
    await request
  }
})

it.each([0, -1, NaN, Infinity, 1.5, 300001])(
  'rejects an invalid timeout configuration: %s',
  (timeoutMs) => {
    const { access } = fixtureAccount()
    expect(() => createKnowledgeClient(access, { timeoutMs })).toThrow('knowledge:invalid-timeout')
  },
)

it('settles account invalidation promptly even while a token reader is still pending', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(page))
  const pending = deferred<string>()
  const { access, token, switchAccount } = fixtureAccount()
  token.mockReturnValue(pending.promise)
  const request = createKnowledgeClient(access)
    .listSpaces()
    .catch((error: unknown) => error)
  switchAccount()
  try {
    expect(await settlesSoon(request)).toMatchObject({ code: 'knowledge:account-changed' })
  } finally {
    pending.resolve('synthetic-late-token-A')
    await request
  }
  expect(network).not.toHaveBeenCalled()
})

it('rejects a late old-account response and cancels its body even when fetch ignores abort', async () => {
  const pending = deferred<Response>()
  const network = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise)
  const { access, switchAccount } = fixtureAccount()
  const request = createKnowledgeClient(access)
    .listSpaces()
    .catch((error: unknown) => error)
  await vi.waitFor(() => expect(network).toHaveBeenCalledOnce())
  const response = Response.json(page)
  const cancel = vi.spyOn(response.body!, 'cancel')
  switchAccount()
  try {
    expect(await settlesSoon(request)).toMatchObject({ code: 'knowledge:account-changed' })
  } finally {
    pending.resolve(response)
    await request
  }
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
})

it('does not read a token or send a request for an already cancelled caller', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(page))
  const { access, token } = fixtureAccount()
  const controller = new AbortController()
  controller.abort()
  await expect(
    createKnowledgeClient(access).listSpaces({}, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'knowledge:cancelled' })
  expect(token).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
})

it('propagates caller cancellation into the in-flight fetch signal', async () => {
  const pending = deferred<Response>()
  const network = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise)
  const { access } = fixtureAccount()
  const controller = new AbortController()
  const request = createKnowledgeClient(access)
    .listSpaces({}, { signal: controller.signal })
    .catch((error: unknown) => error)
  await vi.waitFor(() => expect(network).toHaveBeenCalledOnce())
  controller.abort()
  try {
    expect(await settlesSoon(request)).toMatchObject({ code: 'knowledge:cancelled' })
    expect(network.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  } finally {
    pending.resolve(Response.json(page))
    await request
  }
})

it('closes the client without allowing another token read or request', async () => {
  const { access, token } = fixtureAccount()
  const client = createKnowledgeClient(access)
  client.close()
  await expect(client.listSpaces()).rejects.toMatchObject({ code: 'knowledge:closed' })
  expect(token).not.toHaveBeenCalled()
})

it('bounds a hung token read with the explicit request timeout', async () => {
  const pending = deferred<string>()
  const { access, token } = fixtureAccount()
  token.mockReturnValue(pending.promise)
  const request = createKnowledgeClient(access, { timeoutMs: 5 })
    .listSpaces()
    .catch((error: unknown) => error)
  try {
    expect(await settlesSoon(request)).toMatchObject({ code: 'knowledge:request-timeout' })
  } finally {
    pending.resolve('synthetic-late-token-A')
    await request
  }
})
