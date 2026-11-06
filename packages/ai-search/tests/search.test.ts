import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { webSearch, imageSearch } from '../src/index'

// These cases only test the Serper/DuckDuckGo paths; a local gsk login would take priority, so disable it explicitly
beforeAll(() => {
  process.env.AI_SEARCH_DISABLE_GSK = '1'
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SERPER_API_KEY
  delete process.env.TAVILY_API_KEY
  delete process.env.ALIYUN_IQS_API_KEY
})

function mockFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { ok: boolean; status?: number; json?: any; text?: string },
) {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const r = handler(String(url), init)
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: new Map(),
      json: async () => r.json,
      text: async () => r.text ?? '',
    } as any
  }) as any
}

describe('webSearch (Serper)', () => {
  it('parses organic results + answer box', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    mockFetch((url) => {
      expect(url).toBe('https://google.serper.dev/search')
      return {
        ok: true,
        json: {
          answerBox: { answer: '42' },
          organic: [
            { title: 'A', link: 'https://a.com', snippet: 'sa' },
            { title: 'B', link: 'https://b.com', snippet: 'sb' },
          ],
        },
      }
    })
    const r = await webSearch('meaning of life', 5)
    expect(r.method).toBe('serper')
    expect(r.answer).toBe('42')
    expect(r.results).toHaveLength(2)
    expect(r.results[0]).toEqual({ title: 'A', url: 'https://a.com', snippet: 'sa' })
  })

  it('falls back to DuckDuckGo when no key', async () => {
    mockFetch((url) => {
      expect(url).toContain('duckduckgo.com')
      return {
        ok: true,
        text: '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fx.com">X Title</a>',
      }
    })
    const r = await webSearch('q', 3)
    expect(r.method).toBe('duckduckgo')
    expect(r.results[0]?.url).toBe('https://x.com')
    expect(r.results[0]?.title).toBe('X Title')
  })
})

describe('webSearch (Alibaba Cloud CleverSee)', () => {
  it.each(['', 'x'.repeat(501)])(
    'rejects invalid query length without a network request',
    async (query) => {
      mockFetch(() => {
        throw new Error('must not reach a provider')
      })
      expect((await webSearch(query)).method).toBe('error')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    },
  )

  it('prefers IQS and parses usable pageItems without HTML markup', async () => {
    process.env.ALIYUN_IQS_API_KEY = 'iqs-key'
    process.env.SERPER_API_KEY = 'serper-key'
    process.env.TAVILY_API_KEY = 'tavily-key'
    mockFetch((url, init) => {
      expect(url).toBe('https://cloud-iqs.aliyuncs.com/search/unified')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer iqs-key' })
      expect(JSON.parse(String(init?.body))).toEqual({
        query: '国内搜索',
        engineType: 'CNLiteBasic',
        contents: { mainText: false, markdownText: false, summary: false },
        advancedParams: { numResults: 2 },
      })
      return {
        ok: true,
        json: {
          pageItems: [
            { title: '<em>A</em>', link: 'https://a.com', snippet: 'A &amp; B' },
            { title: 'unsafe', link: 'javascript:alert(1)' },
            { title: '', link: 'https://empty.com' },
            { title: 'B', link: 'https://b.com', snippet: 'sb' },
            { title: 'C', link: 'https://c.com' },
          ],
        },
      }
    })
    const r = await webSearch('国内搜索', 2)
    expect(r).toEqual({
      method: 'aliyun-iqs',
      results: [
        { title: 'A', url: 'https://a.com', snippet: 'A & B' },
        { title: 'B', url: 'https://b.com', snippet: 'sb' },
      ],
    })
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 429, 500])('falls back on IQS HTTP %s', async (status) => {
    process.env.ALIYUN_IQS_API_KEY = 'iqs-key'
    process.env.SERPER_API_KEY = 'serper-key'
    mockFetch((url) =>
      url.includes('cloud-iqs')
        ? { ok: false, status }
        : { ok: true, json: { organic: [{ title: 'A', link: 'https://a.com' }] } },
    )
    expect((await webSearch('q')).method).toBe('serper')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([{}, { pageItems: [] }, { pageItems: [{ title: 'bad', link: '' }] }])(
    'falls back when IQS has no usable results: %j',
    async (json) => {
      process.env.ALIYUN_IQS_API_KEY = 'iqs-key'
      mockFetch((url) =>
        url.includes('cloud-iqs')
          ? { ok: true, json }
          : { ok: true, text: '<a class="result__a" href="https://x.com">X</a>' },
      )
      expect((await webSearch('q')).method).toBe('duckduckgo')
      expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    },
  )

  it('accepts the CleverSee 500-character query boundary', async () => {
    process.env.ALIYUN_IQS_API_KEY = 'iqs-key'
    mockFetch((_url, init) => {
      expect(JSON.parse(String(init?.body)).query).toHaveLength(500)
      return { ok: true, json: { pageItems: [{ title: 'A', link: 'https://a.com' }] } }
    })
    expect((await webSearch('x'.repeat(500))).method).toBe('aliyun-iqs')
  })

  it('bounds the IQS result count', async () => {
    process.env.ALIYUN_IQS_API_KEY = 'iqs-key'
    mockFetch((_url, init) => {
      expect(JSON.parse(String(init?.body)).advancedParams.numResults).toBe(50)
      return { ok: true, json: { pageItems: [{ title: 'A', link: 'https://a.com' }] } }
    })
    expect((await webSearch('q', 1000)).method).toBe('aliyun-iqs')
  })

  it('continues to the keyless backend after an IQS timeout', async () => {
    process.env.ALIYUN_IQS_API_KEY = 'iqs-key'
    mockFetch((url) => {
      if (url.includes('cloud-iqs')) throw new DOMException('timed out', 'TimeoutError')
      return { ok: true, text: '<a class="result__a" href="https://x.com">X</a>' }
    })
    expect((await webSearch('q')).method).toBe('duckduckgo')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('times out an IQS response body that stalls after HTTP headers', async () => {
    process.env.ALIYUN_IQS_API_KEY = 'iqs-key'
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.flushHeaders()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server port')
    globalThis.fetch = vi.fn((url, init) =>
      String(url).includes('cloud-iqs')
        ? realFetch(`http://127.0.0.1:${address.port}`, init)
        : Promise.resolve(new Response('<a class="result__a" href="https://x.com">X</a>')),
    )
    try {
      expect((await webSearch('q')).method).toBe('duckduckgo')
      expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }, 10000)
})

describe('webSearch (Tavily)', () => {
  it('parses results + answer when Serper is unconfigured', async () => {
    process.env.TAVILY_API_KEY = 'test-key'
    mockFetch((url, init) => {
      expect(url).toBe('https://api.tavily.com/search')
      expect(JSON.parse(String((init as any)?.body ?? '{}')).api_key).toBe('test-key')
      return {
        ok: true,
        json: {
          answer: '42',
          results: [
            { title: 'A', url: 'https://a.com', content: 'sa' },
            { title: 'B', url: 'https://b.com', content: 'sb' },
          ],
        },
      }
    })
    const r = await webSearch('meaning of life', 5)
    expect(r.method).toBe('tavily')
    expect(r.answer).toBe('42')
    expect(r.results).toHaveLength(2)
    expect(r.results[0]).toEqual({ title: 'A', url: 'https://a.com', snippet: 'sa' })
  })

  it('prefers Serper over Tavily when both keys are set', async () => {
    process.env.SERPER_API_KEY = 'serper-key'
    process.env.TAVILY_API_KEY = 'tavily-key'
    mockFetch((url) => {
      expect(url).toBe('https://google.serper.dev/search')
      return { ok: true, json: { organic: [{ title: 'A', link: 'https://a.com' }] } }
    })
    const r = await webSearch('q', 3)
    expect(r.method).toBe('serper')
  })

  it('falls back to DuckDuckGo when Tavily returns nothing usable', async () => {
    process.env.TAVILY_API_KEY = 'test-key'
    mockFetch((url) => {
      if (url === 'https://api.tavily.com/search') return { ok: true, json: { results: [] } }
      expect(url).toContain('duckduckgo.com')
      return {
        ok: true,
        text: '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fx.com">X Title</a>',
      }
    })
    const r = await webSearch('q', 3)
    expect(r.method).toBe('duckduckgo')
  })
})

describe('DuckDuckGo fallback error surfacing', () => {
  it('web: reports method error when the backend is unreachable', async () => {
    mockFetch(() => {
      throw new Error('network down')
    })
    const r = await webSearch('q', 3)
    expect(r.method).toBe('error')
    expect(r.results).toHaveLength(0)
    expect(r.error).toContain('duckduckgo')
  })

  it('web: stays a plain empty result when the backend responds with nothing', async () => {
    mockFetch(() => ({ ok: true, text: '<html></html>' }))
    const r = await webSearch('q', 3)
    expect(r.method).toBe('duckduckgo')
    expect(r.results).toHaveLength(0)
    expect(r.error).toBeUndefined()
  })

  it('images: reports method error when the backend is unreachable', async () => {
    mockFetch(() => {
      throw new Error('network down')
    })
    const r = await imageSearch('cats', 8)
    expect(r.method).toBe('error')
    expect(r.images).toHaveLength(0)
    expect(r.error).toContain('duckduckgo')
  })
})

describe('imageSearch (Serper)', () => {
  it('parses images + filters copyright hosts', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    mockFetch((url) => {
      expect(url).toBe('https://google.serper.dev/images')
      return {
        ok: true,
        json: {
          images: [
            {
              title: 'good',
              imageUrl: 'https://cdn.example.com/a.jpg',
              link: 'https://example.com',
              imageWidth: 800,
              imageHeight: 600,
            },
            {
              title: 'paid',
              imageUrl: 'https://gettyimages.com/x.jpg',
              link: 'https://gettyimages.com',
            },
          ],
        },
      }
    })
    const r = await imageSearch('cats', 8)
    expect(r.method).toBe('serper')
    expect(r.images).toHaveLength(1) // getty is filtered out
    expect(r.images[0]).toMatchObject({
      imageUrl: 'https://cdn.example.com/a.jpg',
      width: 800,
      height: 600,
    })
  })
})
