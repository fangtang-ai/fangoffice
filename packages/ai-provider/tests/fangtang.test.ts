import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { AI_PROVIDER_ADAPTERS } from '../src/registry'
import { AiCreditsError, streamForProvider } from '../src/stream'
import { jsonResponse, okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SITE_URL = 'https://test.fang-tang.cn/api/office/ai/chat'

function collector() {
  const deltas: string[] = []
  const toolCalls: AgentToolCall[] = []
  return {
    deltas,
    toolCalls,
    cb: {
      signal: new AbortController().signal,
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => toolCalls.push(call),
    },
  }
}

describe('fangtang billing proxy', () => {
  it('resolves the account-registered full chat URL as-is', () => {
    expect(
      AI_PROVIDER_ADAPTERS.fangtang.resolveEndpoint({
        apiKey: '',
        model: 'qwen3.5-plus',
        baseUrl: SITE_URL,
      }),
    ).toEqual({ protocol: 'fangtang', baseUrl: SITE_URL })
    expect(() =>
      AI_PROVIDER_ADAPTERS.fangtang.resolveEndpoint({ apiKey: '', model: 'm' }),
    ).toThrow('The FangTang provider requires a Base URL')
  })

  it('posts the site contract: bearer token, idempotency-key, system folded first, tool turns stringified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(
        sseStream([
          'data: {"type":"meta","requestId":"r1","model":"qwen3.5-plus"}',
          'data: {"type":"delta","content":"你好"}',
          'data: {"type":"usage","inputTokens":10,"outputTokens":2,"totalTokens":12}',
          'data: {"type":"charge","requestId":"r1","amountFen":3,"inputTokens":10,"outputTokens":2}',
          'data: {"type":"done","requestId":"r1"}',
        ]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider(
      'fangtang',
      { apiKey: 'logto-token', model: 'qwen3.5-plus', baseUrl: SITE_URL },
      '系统提示',
      [
        { role: 'user', text: 'hi' },
        { role: 'tool', results: [{ id: 't1', name: 'search', output: '{"hits":1}' }] },
      ],
      [],
      100,
      cb,
    )
    expect(deltas).toEqual(['你好'])
    expect(toolCalls).toEqual([])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(SITE_URL)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer logto-token')
    expect(headers['idempotency-key']).toBeTruthy()
    expect(JSON.parse(init.body as string)).toEqual({
      capability: 'chat',
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: 'hi' },
        { role: 'tool', content: '{"hits":1}' },
      ],
    })
  })

  it('maps an in-band error event to AiCreditsError for money codes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(
        sseStream(['data: {"type":"error","code":"insufficient_balance","message":"余额不足"}']),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamForProvider(
        'fangtang',
        { apiKey: 't', model: 'm', baseUrl: SITE_URL },
        'sys',
        [],
        [],
        100,
        collector().cb,
      ),
    ).rejects.toThrow(AiCreditsError)
  })

  it('maps an HTTP 400 余额不足 rejection (before any SSE) to AiCreditsError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: '余额不足', error: 'Bad Request', statusCode: 400 }, 400))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamForProvider(
        'fangtang',
        { apiKey: 't', model: 'm', baseUrl: SITE_URL },
        'sys',
        [],
        [],
        100,
        collector().cb,
      ),
    ).rejects.toThrow(AiCreditsError)
  })
})
