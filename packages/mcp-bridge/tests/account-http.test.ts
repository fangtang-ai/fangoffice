import { afterEach, expect, it, vi } from 'vitest'
import { McpHub } from '../src/hub'
import {
  createAccountMcpFetch,
  resolveAccountMcpUrl,
  type AccountMcpAccess,
} from '../src/account-http'

afterEach(() => vi.restoreAllMocks())

const TEST_CONTEXT = {
  aiRunId: 'f4245812-731b-43e0-a1b4-ef2810140b05',
  logicalCallId: '49520531-9c09-4915-8c40-7599c4385753',
}

it('requires valid application metadata before any paid tool request or token read', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) => rpcResponse(init))
  const access = accountAccess()
  const hub = new McpHub(
    {
      policy: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
      },
    },
    { account: access },
  )
  try {
    expect(await hub.callTool('policy', 'search', {})).toEqual({
      text: 'invalid_call_metadata',
      isError: true,
    })
    expect(network).not.toHaveBeenCalled()
    expect(access.token).not.toHaveBeenCalled()
  } finally {
    await hub.shutdown()
  }
})

it.each(['tool-text', 'tool-structured', 'http'] as const)(
  'adapts trusted %s billing errors without exposing tool-provided recharge URLs or diagnostics',
  async (mode) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const rpc = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string }
      if (rpc.method !== 'tools/call') return rpcResponse(init)
      const failure = {
        code: 'insufficient_balance',
        product: 'policy_mcp',
        rechargeUrl: 'https://outside.invalid/payment',
        traceId: 'changing-trace',
      }
      if (mode === 'http') return new Response(JSON.stringify(failure), { status: 402 })
      const result = {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(failure) }],
        ...(mode === 'tool-structured'
          ? {
              structuredContent: {
                code: 'quota_exceeded',
                limitDimension: 'day',
                resetAt: '2026-10-11T00:00:00.000Z',
              },
            }
          : {}),
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const hub = new McpHub(
      {
        policy: {
          transport: 'http',
          auth: 'fangtang-account',
          enabled: true,
          url: '${ACCOUNT_API_BASE}/api/office/mcp',
        },
      },
      { account: accountAccess() },
    )
    try {
      const result = await hub.callTool('policy', 'search', {}, TEST_CONTEXT)
      expect(result.isError).toBe(true)
      expect(result.billing).toMatchObject({
        ...TEST_CONTEXT,
        product: 'policy_mcp',
        error: {
          code: mode === 'tool-structured' ? 'quota_exceeded' : 'insufficient_balance',
          retryAllowed: false,
        },
      })
      if (mode === 'tool-structured')
        expect(result.billing?.error).toMatchObject({
          limitDimension: 'day',
          resetAt: '2026-10-11T00:00:00.000Z',
        })
      expect(result.text).not.toContain('outside.invalid')
      expect(result.text).not.toContain('changing-trace')
    } finally {
      await hub.shutdown()
    }
  },
)

function accountAccess(): AccountMcpAccess {
  const binding = { userId: 'account-A', sessionId: 1, signal: new AbortController().signal }
  return {
    apiBase: () => 'https://account.invalid/api',
    bind: () => binding,
    isCurrent: () => true,
    token: vi.fn().mockResolvedValue('synthetic-token'),
  }
}

function rpcResponse(init?: RequestInit) {
  if (init?.method === 'GET') return new Response(null, { status: 405 })
  const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string }
  if (body.id === undefined) return new Response(null, { status: 202 })
  const result =
    body.method === 'initialize'
      ? {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        }
      : { content: [{ type: 'text', text: 'ok' }] }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

it('reads a valid account token for every SDK HTTP request rather than caching headers', async () => {
  const headers: Headers[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    headers.push(new Headers(init?.headers))
    return rpcResponse(init)
  })
  const access = accountAccess()
  const token = vi.fn().mockImplementation(async () => `synthetic-${headers.length}`)
  access.token = token
  const hub = new McpHub(
    {
      policy: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
      },
    },
    { account: access },
  )
  try {
    expect(await hub.callTool('policy', 'search', {}, TEST_CONTEXT)).toEqual({
      text: 'ok',
      isError: false,
    })
    expect(token).toHaveBeenCalledTimes(headers.length)
    expect(headers.length).toBeGreaterThanOrEqual(3)
    expect(
      headers.every((header) => header.get('Authorization')?.startsWith('Bearer synthetic-')),
    ).toBe(true)
  } finally {
    await hub.shutdown()
  }
})

it.each([
  'https://account.invalid/api/mcp',
  'https://account.invalid/api/office/mcp?secret=x',
  'https://user:password@account.invalid/api/office/mcp',
  'https://account.invalid/api/office/mcp#fragment',
  'http://account.invalid/api/office/mcp',
])('rejects a managed URL outside the exact endpoint: %s', (url) => {
  expect(() => resolveAccountMcpUrl(url, accountAccess())).toThrow('account:untrusted-target')
})

it('uses the origin-relative endpoint once and allows HTTP only for explicitly permitted loopback', () => {
  const access = accountAccess()
  expect(resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access).href).toBe(
    'https://account.invalid/api/office/mcp',
  )
  access.apiBase = () => 'http://127.0.0.1:58192/api'
  expect(() => resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access)).toThrow(
    'account:untrusted-target',
  )
  access.allowLoopback = true
  expect(resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access).href).toBe(
    'http://127.0.0.1:58192/api/office/mcp',
  )
  access.apiBase = () => 'http://external.invalid'
  expect(() => resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access)).toThrow(
    'account:untrusted-target',
  )
})

it('refreshes once after 401 and replays the exact same HTTP body and logical call', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response('ok'))
  const access = accountAccess()
  const token = vi.fn().mockResolvedValueOnce('expired').mockResolvedValueOnce('renewed')
  access.token = token
  const binding = access.bind()
  const endpoint = resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access)
  const fetch = createAccountMcpFetch(endpoint, access, binding)
  const body = '{"method":"tools/call","params":{"_meta":{"logicalCallId":"same-call"}}}'
  expect((await fetch(endpoint, { method: 'POST', body })).status).toBe(200)
  expect(network).toHaveBeenCalledTimes(2)
  expect(token).toHaveBeenNthCalledWith(2, binding, 'expired')
  expect(network.mock.calls.map((call) => call[1]?.body)).toEqual([body, body])
  expect(
    network.mock.calls.map((call) => new Headers(call[1]?.headers).get('Authorization')),
  ).toEqual(['Bearer expired', 'Bearer renewed'])
  expect(network.mock.calls.every((call) => call[1]?.redirect === 'error')).toBe(true)
})

it('shares a single connection initialization across concurrent account calls', async () => {
  let initializations = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (String(init?.body).includes('"method":"initialize"')) initializations++
    return rpcResponse(init)
  })
  const hub = new McpHub(
    {
      policy: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
      },
    },
    { account: accountAccess() },
  )
  try {
    const results = await Promise.all([
      hub.callTool('policy', 'search', {}, TEST_CONTEXT),
      hub.callTool('policy', 'search', {}, TEST_CONTEXT),
    ])
    expect(results.every((result) => !result.isError)).toBe(true)
    expect(initializations).toBe(1)
  } finally {
    await hub.shutdown()
  }
})

it('stops after the second 401 and categorizes failed refreshes as login errors', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 401 }))
  const access = accountAccess()
  const endpoint = resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access)
  const request = createAccountMcpFetch(endpoint, access, access.bind())
  await expect(request(endpoint)).rejects.toThrow('account:required')
  expect(network).toHaveBeenCalledTimes(2)
  network.mockClear()
  access.token = vi.fn().mockRejectedValue(new Error('refresh credentials must not be exposed'))
  await expect(request(endpoint)).rejects.toThrow('account:required')
  expect(network).not.toHaveBeenCalled()
})

it('does not retry under another account after a 401 or read the new token', async () => {
  const access = accountAccess()
  const controller = new AbortController()
  access.bind = () => ({ userId: 'account-A', sessionId: 1, signal: controller.signal })
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    controller.abort()
    access.isCurrent = () => false
    return new Response(null, { status: 401 })
  })
  const token = vi.fn().mockResolvedValue('only-A')
  access.token = token
  const endpoint = resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access)
  await expect(createAccountMcpFetch(endpoint, access, access.bind())(endpoint)).rejects.toThrow(
    'account:changed',
  )
  expect(network).toHaveBeenCalledTimes(1)
  expect(token).toHaveBeenCalledTimes(1)
})

it('never follows redirects or forwards caller credentials, and never reveals raw network errors', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://outside.invalid' } }),
    )
  const access = accountAccess()
  const endpoint = resolveAccountMcpUrl('${ACCOUNT_API_BASE}/api/office/mcp', access)
  const request = createAccountMcpFetch(endpoint, access, access.bind())
  await expect(
    request(endpoint, {
      headers: {
        Cookie: 'private',
        Authorization: 'caller-secret',
        'Proxy-Authorization': 'private',
      },
      redirect: 'follow',
    }),
  ).rejects.toThrow('account:untrusted-target')
  const init = network.mock.calls[0]![1]!
  expect(new Headers(init.headers).get('Cookie')).toBeNull()
  expect(new Headers(init.headers).get('Proxy-Authorization')).toBeNull()
  expect(init.credentials).toBe('omit')
  expect(init.redirect).toBe('error')
  network.mockRejectedValue(new Error('synthetic-token secret-header'))
  await expect(request(endpoint)).rejects.toThrow('account:request-failed')
})

it('closes account connections and tool caches immediately when the account is invalidated', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => rpcResponse(init))
  let invalidate = () => {}
  const access = {
    ...accountAccess(),
    subscribe: (listener: () => void) => {
      invalidate = listener
      return () => {}
    },
  }
  const hub = new McpHub(
    {
      policy: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
      },
    },
    { account: access },
  )
  try {
    expect((await hub.callTool('policy', 'search', {}, TEST_CONTEXT)).isError).toBe(false)
    expect(hub.status()[0]?.connected).toBe(true)
    invalidate()
    expect(hub.status()[0]?.connected).toBe(false)
    expect(hub.status()[0]?.toolCount).toBe(0)
  } finally {
    await hub.shutdown()
  }
})

it('sends typed billing metadata separately from tool arguments and returns trusted billing as a side channel', async () => {
  const context = {
    aiRunId: 'f4245812-731b-43e0-a1b4-ef2810140b05',
    logicalCallId: '49520531-9c09-4915-8c40-7599c4385753',
  }
  const calls: Array<{ params?: Record<string, unknown> }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
    }
    if (request.method !== 'tools/call') return rpcResponse(init)
    calls.push(request)
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: 'business-result' }],
          _meta: {
            'fang-tang.cn/billing': {
              ...context,
              product: 'policy_mcp',
              status: 'settled',
              amountFen: 50,
            },
          },
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  })
  const hub = new McpHub(
    {
      policy: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
      },
    },
    { account: accountAccess() },
  )
  try {
    const result = await hub.callTool('policy', 'search', { query: 'business' }, context)
    expect(calls[0]?.params).toEqual({
      name: 'search',
      arguments: { query: 'business' },
      _meta: { 'fang-tang.cn/billing': context },
    })
    expect(result.text).toBe('business-result')
    expect(result.billing).toEqual({
      ...context,
      product: 'policy_mcp',
      status: 'settled',
      amountFen: 50,
    })
  } finally {
    await hub.shutdown()
  }
})

it('rejects an account-auth server on an untrusted origin before fetching or reading a token', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected-network'))
  const token = vi.fn().mockResolvedValue('synthetic-token')
  const binding = { userId: 'account-A', sessionId: 1, signal: new AbortController().signal }
  const hub = new McpHub(
    {
      policy: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: 'https://outside.invalid/api/office/mcp',
      },
    },
    {
      account: {
        apiBase: () => 'https://account.invalid/api',
        bind: () => binding,
        isCurrent: () => true,
        token,
      },
    },
  )
  try {
    const result = await hub.callTool('policy', 'search', {}, TEST_CONTEXT)
    expect(result).toMatchObject({ text: 'account:untrusted-target', isError: true })
    expect(network).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
  } finally {
    await hub.shutdown()
  }
})
