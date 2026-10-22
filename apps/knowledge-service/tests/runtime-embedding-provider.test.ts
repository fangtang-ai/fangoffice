import { expect, it, vi } from 'vitest'
import {
  createDashscopeEmbeddingClient,
  parseKnowledgeEmbeddingProviderConfig,
  KnowledgeEmbeddingProviderError,
} from '../src/runtime'

const embedding = Array.from({ length: 1024 }, (_, index) => (index % 7 === 0 ? -0.25 : 0.125))
const config = {
  baseUrl: 'https://provider.example/compatible-mode/v1',
  model: 'text-embedding-v4',
  dimensions: 1024,
  timeoutMs: 20000,
  batchSize: 10,
  apiKey: 'test-api-key',
}

const jsonResponse = (status: number, body: string | unknown, requestId?: string) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: requestId === undefined ? {} : { 'x-dashscope-request-id': requestId },
  })

it('returns undefined when every embedding setting is absent', () => {
  expect(parseKnowledgeEmbeddingProviderConfig({})).toBeUndefined()
})

const okPayload = {
  id: 'req-1',
  model: 'text-embedding-v4',
  data: [{ embedding, index: 0 }],
  usage: { total_tokens: 32 },
}

it.each([
  { KNOWLEDGE_EMBEDDING_BASE_URL: 'https://provider.example/v1' },
  {
    KNOWLEDGE_EMBEDDING_BASE_URL: 'https://provider.example/v1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
  },
  {
    KNOWLEDGE_EMBEDDING_BASE_URL: 'http://provider.example/v1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '1024',
    KNOWLEDGE_EMBEDDING_TIMEOUT_MS: '20000',
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: '10',
    KNOWLEDGE_EMBEDDING_API_KEY: 'k',
  },
  {
    KNOWLEDGE_EMBEDDING_BASE_URL: 'https://user:secret@provider.example/v1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '1024',
    KNOWLEDGE_EMBEDDING_TIMEOUT_MS: '20000',
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: '10',
    KNOWLEDGE_EMBEDDING_API_KEY: 'k',
  },
  {
    KNOWLEDGE_EMBEDDING_BASE_URL: 'https://provider.example/v1?x=1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '1024',
    KNOWLEDGE_EMBEDDING_TIMEOUT_MS: '20000',
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: '10',
    KNOWLEDGE_EMBEDDING_API_KEY: 'k',
  },
  {
    KNOWLEDGE_EMBEDDING_BASE_URL: 'https://provider.example/v1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '0',
    KNOWLEDGE_EMBEDDING_TIMEOUT_MS: '20000',
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: '10',
    KNOWLEDGE_EMBEDDING_API_KEY: 'k',
  },
  {
    KNOWLEDGE_EMBEDDING_BASE_URL: 'https://provider.example/v1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '1024',
    KNOWLEDGE_EMBEDDING_TIMEOUT_MS: '0',
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: '10',
    KNOWLEDGE_EMBEDDING_API_KEY: 'k',
  },
  {
    KNOWLEDGE_EMBEDDING_BASE_URL: 'https://provider.example/v1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '1024',
    KNOWLEDGE_EMBEDDING_TIMEOUT_MS: '20000',
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: '11',
    KNOWLEDGE_EMBEDDING_API_KEY: 'k',
  },
])('rejects partial or invalid embedding configuration: %j', async (values) => {
  expect(() => parseKnowledgeEmbeddingProviderConfig(values)).toThrow(
    expect.objectContaining({ code: 'NOT_CONFIGURED' }),
  )
})

it('parses a valid configuration into frozen numbers', () => {
  const parsed = parseKnowledgeEmbeddingProviderConfig({
    KNOWLEDGE_EMBEDDING_BASE_URL: 'https://provider.example/compatible-mode/v1',
    KNOWLEDGE_EMBEDDING_MODEL: 'text-embedding-v4',
    KNOWLEDGE_EMBEDDING_DIMENSIONS: '1024',
    KNOWLEDGE_EMBEDDING_TIMEOUT_MS: '20000',
    KNOWLEDGE_EMBEDDING_BATCH_SIZE: '10',
    KNOWLEDGE_EMBEDDING_API_KEY: 'test-api-key',
  })
  expect(parsed).toEqual(config)
  expect(Object.isFrozen(parsed)).toBe(true)
})

it('sends one bounded provider request and maps a valid response', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, okPayload))
  const client = createDashscopeEmbeddingClient(config, { fetch: fetchMock })
  const outcome = await client(['方塘合成测试文本'])
  expect(outcome.vectors).toEqual([embedding])
  expect(outcome.usageTokens).toBe(32)
  expect(outcome.requestId).toBe('req-1')
  expect(fetchMock).toHaveBeenCalledOnce()
  const [url, request] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit & { body: string },
  ]
  expect(url).toBe('https://provider.example/compatible-mode/v1/embeddings')
  expect(request.method).toBe('POST')
  expect(request.headers).toMatchObject({
    authorization: 'Bearer test-api-key',
    'content-type': 'application/json',
  })
  expect(JSON.parse(request.body)).toEqual({
    model: 'text-embedding-v4',
    input: ['方塘合成测试文本'],
    dimensions: 1024,
    encoding_format: 'float',
  })
  expect(request.signal).toBeInstanceOf(AbortSignal)
})

it('falls back to the response header for the request id and tolerates missing usage', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    jsonResponse(200, { data: [{ embedding }] }, 'rid-header'),
  )
  const client = createDashscopeEmbeddingClient(config, { fetch: fetchMock })
  const outcome = await client(['方塘合成测试文本'])
  expect(outcome.usageTokens).toBeNull()
  expect(outcome.requestId).toBe('rid-header')
})

it.each([
  { input: [] as string[], label: 'empty batch' },
  { input: Array.from({ length: 11 }, (_, index) => `文本${index}`), label: 'over batch size' },
  { input: [''], label: 'empty text' },
  { input: ['a', ''], label: 'one empty text in batch' },
])('rejects invalid input before any network call: %j', async ({ input }) => {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, okPayload))
  const client = createDashscopeEmbeddingClient(config, { fetch: fetchMock })
  await expect(client(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(fetchMock).not.toHaveBeenCalled()
})

it.each([
  { status: 401, code: 'provider_rejected' },
  { status: 403, code: 'provider_rejected' },
  { status: 429, code: 'provider_rejected' },
  { status: 500, code: 'provider_unavailable' },
  { status: 503, code: 'provider_unavailable' },
])('classifies HTTP $status as $code without leaking the key', async ({ status, code }) => {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(status, { error: 'nope' }))
  const client = createDashscopeEmbeddingClient(config, { fetch: fetchMock })
  const failure = (await client(['方塘合成测试文本']).catch(
    (error) => error,
  )) as KnowledgeEmbeddingProviderError
  expect(failure).toBeInstanceOf(KnowledgeEmbeddingProviderError)
  expect(failure.code).toBe(code)
  expect(failure.message).not.toContain('test-api-key')
  expect(failure.message).not.toContain('nope')
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('maps a timeout abort to provider_unavailable', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const aborted = new Error('The operation was aborted due to timeout')
    aborted.name = 'TimeoutError'
    throw aborted
  })
  const client = createDashscopeEmbeddingClient(config, { fetch: fetchMock })
  await expect(client(['方塘合成测试文本'])).rejects.toMatchObject({
    code: 'provider_unavailable',
  })
})

it.each([
  { body: 'not-json', label: 'malformed json' },
  { body: JSON.stringify({ usage: { total_tokens: 32 } }), label: 'missing data' },
  {
    body: JSON.stringify({ data: [{ embedding: embedding.slice(0, 1023) }], usage: {} }),
    label: 'dimension mismatch',
  },
  {
    body: JSON.stringify({ data: [{ embedding }, { embedding }], usage: {} }),
    label: 'count mismatch',
  },
  {
    body: `{"data":[{"embedding":[${embedding.join(',').replace('-0.25', '1e999')}]}]}`,
    label: 'non-finite value',
  },
])('marks an unusable 200 response as provider_malformed: %j', async ({ body }) => {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, body))
  const client = createDashscopeEmbeddingClient(config, { fetch: fetchMock })
  await expect(client(['方塘合成测试文本'])).rejects.toMatchObject({
    code: 'provider_malformed',
  })
})

it('freezes returned vectors so callers cannot mutate provider output', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, okPayload))
  const client = createDashscopeEmbeddingClient(config, { fetch: fetchMock })
  const outcome = await client(['方塘合成测试文本'])
  expect(Object.isFrozen(outcome)).toBe(true)
  expect(Object.isFrozen(outcome.vectors)).toBe(true)
  expect(Object.isFrozen(outcome.vectors[0])).toBe(true)
})
