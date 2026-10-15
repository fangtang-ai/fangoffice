import { expect, it, vi } from 'vitest'
import { createKnowledgeAuthenticator } from '../src/runtime'
import { now } from './fixtures'
import { apiConfig } from './runtime-fixtures'
import { accessToken, publicKeySet } from './runtime-auth-fixtures'

it.each(['status', 'flag', 'url'])(
  'refuses a redirecting JWKS adapter response: %s',
  async (mode) => {
    const response = Response.json(publicKeySet, { status: mode === 'status' ? 302 : 200 })
    if (mode === 'flag') Object.defineProperty(response, 'redirected', { value: true })
    if (mode === 'url')
      Object.defineProperty(response, 'url', { value: 'https://outside.invalid/jwks' })
    const cancelled = vi.spyOn(response.body!, 'cancel')
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response)
    const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
      fetch: transport,
      now: () => now,
    })
    await expect(authenticate(`Bearer ${await accessToken()}`)).rejects.toThrow(
      'SERVICE_UNAVAILABLE',
    )
    expect(cancelled).toHaveBeenCalledOnce()
  },
)

it('rejects an oversized declared JWKS before reading its otherwise-valid key set', async () => {
  const response = Response.json(publicKeySet, { headers: { 'Content-Length': '262145' } })
  const cancelled = vi.spyOn(response.body!, 'cancel')
  const json = vi.spyOn(response, 'json')
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response)
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
  })
  await expect(authenticate(`Bearer ${await accessToken()}`)).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(json).not.toHaveBeenCalled()
  expect(cancelled).toHaveBeenCalledOnce()
})

it('bounds actual streamed JWKS bytes even without a Content-Length header', async () => {
  const response = Response.json({ ...publicKeySet, padding: 'x'.repeat(262144) })
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response)
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
  })
  await expect(authenticate(`Bearer ${await accessToken()}`)).rejects.toThrow('SERVICE_UNAVAILABLE')
})

it('bounds a key fetch even when the transport ignores the abort signal', async () => {
  let resolve!: (response: Response) => void
  const transport = vi.fn<typeof fetch>().mockReturnValue(
    new Promise<Response>((finish) => {
      resolve = finish
    }),
  )
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
    jwksTimeoutMs: 5,
  })
  const request = authenticate(`Bearer ${await accessToken()}`)
  try {
    await expect(request).rejects.toThrow('SERVICE_UNAVAILABLE')
  } finally {
    resolve(Response.json(publicKeySet))
  }
})

it('releases the body of a key response arriving after its deadline', async () => {
  let resolve!: (response: Response) => void
  const transport = vi.fn<typeof fetch>().mockReturnValue(
    new Promise<Response>((finish) => {
      resolve = finish
    }),
  )
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
    jwksTimeoutMs: 5,
  })
  await expect(authenticate(`Bearer ${await accessToken()}`)).rejects.toThrow('SERVICE_UNAVAILABLE')
  const response = Response.json(publicKeySet)
  const cancel = vi.spyOn(response.body!, 'cancel')
  resolve(response)
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
})

it.each([0, -1, NaN, Infinity, 30001])(
  'refuses an unbounded or invalid JWKS timeout: %s',
  (jwksTimeoutMs) => {
    expect(() => createKnowledgeAuthenticator(apiConfig().auth, { jwksTimeoutMs })).toThrow(
      'NOT_CONFIGURED',
    )
  },
)

it('never exposes a transport failure or private key-server response body', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error('synthetic-private-keyserver-diagnostic'))
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
  })
  await expect(authenticate(`Bearer ${await accessToken()}`)).rejects.toThrow('SERVICE_UNAVAILABLE')
})

it('cancels a stalled response body at the total JWKS deadline', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'))
    },
    cancel,
  })
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
    jwksTimeoutMs: 5,
  })
  await expect(authenticate(`Bearer ${await accessToken()}`)).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(cancel).toHaveBeenCalledOnce()
})

it.each(['not-json', '{"keys":null}'])(
  'sanitizes malformed key-server documents: %s',
  async (body) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
      fetch: transport,
      now: () => now,
    })
    await expect(authenticate(`Bearer ${await accessToken()}`)).rejects.toThrow(
      'SERVICE_UNAVAILABLE',
    )
  },
)

it('retries a failed key service instead of permanently caching a transport error', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('synthetic-private-diagnostic'))
    .mockResolvedValueOnce(Response.json(publicKeySet))
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
  })
  const token = await accessToken()
  await expect(authenticate(`Bearer ${token}`)).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect((await authenticate(`Bearer ${token}`)).ownerId).toBe('synthetic-owner-A')
  expect(transport).toHaveBeenCalledTimes(2)
})
