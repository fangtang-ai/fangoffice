import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeClient, KnowledgeClientError } from '../src'
import { deferred, fixtureAccount, page, spaceId } from './fixtures'

afterEach(() => vi.restoreAllMocks())

it.each(['synthetic\u0085token', 'synthetic token', 'synthetic\r\ntoken'])(
  'rejects control-bearing tokens before network access',
  async (value) => {
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(page))
    const { access, token } = fixtureAccount()
    token.mockResolvedValue(value)
    await expect(createKnowledgeClient(access).listSpaces()).rejects.toMatchObject({
      code: 'knowledge:account-required',
    })
    expect(network).not.toHaveBeenCalled()
  },
)

it('refreshes a rejected token once while retaining the original account binding', async () => {
  const rejected = new Response('ignored', { status: 401 })
  const cancel = vi.spyOn(rejected.body!, 'cancel')
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(Response.json(page))
  const { access, token } = fixtureAccount()
  expect(await createKnowledgeClient(access).listSpaces()).toEqual(page)
  expect(network).toHaveBeenCalledTimes(2)
  expect(cancel).toHaveBeenCalledOnce()
  expect(token).toHaveBeenCalledTimes(2)
  expect(token.mock.calls[1]?.[0]).toEqual(token.mock.calls[0]?.[0])
  expect(token.mock.calls[1]?.[1]).toBe('synthetic-token-A')
  expect(new Headers(network.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
    'Bearer synthetic-renewed-token-A',
  )
})

it('does not loop on a second 401 or forward its error body', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('synthetic secret', { status: 401 }))
  const { access } = fixtureAccount()
  await expect(createKnowledgeClient(access).listSpaces()).rejects.toMatchObject({
    code: 'knowledge:account-required',
  })
  expect(network).toHaveBeenCalledTimes(2)
})

it('rejects an empty token before sending any request', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(page))
  const { access, token } = fixtureAccount()
  token.mockResolvedValue('')
  await expect(createKnowledgeClient(access).listSpaces()).rejects.toMatchObject({
    code: 'knowledge:account-required',
  })
  expect(network).not.toHaveBeenCalled()
})

it('requires a current login without exposing the account implementation error', async () => {
  const { access } = fixtureAccount()
  access.bind = () => {
    throw new Error('synthetic private account data')
  }
  await expect(createKnowledgeClient(access).listSpaces()).rejects.toThrow(
    'knowledge:account-required',
  )
})

it.each(['redirect-status', 'redirected-flag', 'changed-response-url'])(
  'rejects %s even if a fetch adapter ignores redirect:error',
  async (mode) => {
    const response = Response.json(page, { status: mode === 'redirect-status' ? 302 : 200 })
    if (mode === 'redirected-flag') Object.defineProperty(response, 'redirected', { value: true })
    if (mode === 'changed-response-url')
      Object.defineProperty(response, 'url', { value: 'https://outside.invalid/secret' })
    const cancelled = vi.spyOn(response.body!, 'cancel')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const { access } = fixtureAccount()
    await expect(createKnowledgeClient(access).listSpaces()).rejects.toMatchObject({
      code: 'knowledge:untrusted-target',
    })
    expect(cancelled).toHaveBeenCalledOnce()
  },
)

it('rechecks the trusted endpoint after an asynchronous token read', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(page))
  const pending = deferred<string>()
  const { access, token } = fixtureAccount()
  token.mockReturnValue(pending.promise)
  const request = createKnowledgeClient(access).listSpaces()
  access.knowledgeBase = () => 'https://outside.invalid/api/knowledge'
  pending.resolve('synthetic-token-A')
  await expect(request).rejects.toMatchObject({ code: 'knowledge:untrusted-target' })
  expect(network).not.toHaveBeenCalled()
})

it('exposes only whitelisted structured HTTP problems', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ code: 'QUOTA_EXCEEDED', requestId: spaceId }, { status: 429 }),
  )
  const { access } = fixtureAccount()
  await expect(createKnowledgeClient(access).listSpaces()).rejects.toMatchObject({
    code: 'knowledge:request-failed',
    problem: { code: 'QUOTA_EXCEEDED', requestId: spaceId },
  })
})

it('never treats a 500 response containing valid-looking spaces as success', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(page, { status: 500 }))
  const { access } = fixtureAccount()
  await expect(createKnowledgeClient(access).listSpaces()).rejects.toBeInstanceOf(
    KnowledgeClientError,
  )
})
