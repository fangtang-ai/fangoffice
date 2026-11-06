import { afterEach, describe, expect, it, vi } from 'vitest'
import { webSearch } from '../src/index'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const access = { url: 'https://test.fang-tang.cn/api/office/search', token: 'account-test-token' }

describe('account managed search', () => {
  it('uses the account proxy without any company key on the client', async () => {
    vi.stubEnv('ALIYUN_IQS_API_KEY', undefined)
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          method: 'aliyun-iqs',
          results: [{ title: '政策', url: 'https://example.com/policy', snippet: '原文' }],
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await webSearch(' 政策 ', 3, access)).toEqual({
      method: 'aliyun-iqs',
      results: [{ title: '政策', url: 'https://example.com/policy', snippet: '原文' }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(access.url)
    expect(init.headers.Authorization).toBe('Bearer account-test-token')
    expect(JSON.parse(init.body)).toEqual({ query: '政策', maxResults: 3 })
    expect(init.redirect).toBe('error')
  })

  it.each([401, 429, 503])(
    'signals policy fallback on HTTP %s and never tries direct providers',
    async (status) => {
      vi.stubEnv('ALIYUN_IQS_API_KEY', 'local-test-key')
      vi.stubEnv('SERPER_API_KEY', 'local-serper-key')
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('private upstream message', { status }))
      vi.stubGlobal('fetch', fetchMock)
      expect(await webSearch('q', 6, access)).toMatchObject({ results: [], method: 'error' })
      expect(fetchMock).toHaveBeenCalledOnce()
    },
  )

  it('fails closed when logged out and does not make a network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await webSearch('q', 6, { ...access, token: '' })).toMatchObject({ method: 'error' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([{ success: false }, { success: true, data: { method: 'wrong', results: [] } }])(
    'rejects invalid server payloads',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
      expect(await webSearch('q', 6, access)).toMatchObject({ results: [], method: 'error' })
    },
  )

  it('preserves empty results for policy fallback and filters unsafe links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          data: {
            method: 'aliyun-iqs',
            results: [{ title: 'bad', url: 'javascript:alert(1)' }],
          },
        }),
      ),
    )
    expect(await webSearch('q', 6, access)).toEqual({ results: [], method: 'aliyun-iqs' })
  })

  it('sanitizes network error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(access.token)))
    const result = await webSearch('q', 6, access)
    expect(result.method).toBe('error')
    expect(JSON.stringify(result)).not.toContain(access.token)
  })
})
