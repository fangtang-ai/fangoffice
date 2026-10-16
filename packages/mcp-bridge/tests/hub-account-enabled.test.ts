import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { McpHub } from '../src/hub'

it('blocks managed discovery and calls immediately when disabled, preserves other MCPs and reconnects on enable', async () => {
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    let text = ''
    for await (const chunk of request) text += String(chunk)
    const rpc = JSON.parse(text) as { id?: number; method: string }
    requests.push(`${request.headers.authorization ?? 'custom'}:${rpc.method}`)
    if (rpc.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result =
      rpc.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'local-fixture', version: '1' },
          }
        : rpc.method === 'tools/list'
          ? { tools: [{ name: 'search', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'local-success' }] }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const apiBase = `http://127.0.0.1:${address.port}`
  const hub = new McpHub(
    {
      office: {
        transport: 'http',
        auth: 'fangtang-account',
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
        enabled: true,
        alwaysAvailable: true,
      },
      custom: {
        transport: 'http',
        url: `${apiBase}/api/office/mcp`,
        enabled: true,
        alwaysAvailable: true,
      },
    },
    {
      account: {
        apiBase: () => apiBase,
        allowLoopback: true,
        bind: () => ({ userId: 'fixture', sessionId: 1, signal: new AbortController().signal }),
        isCurrent: () => true,
        token: async () => 'fixture-token',
      },
    },
  )
  const context = {
    aiRunId: 'f4245812-731b-43e0-a1b4-ef2810140b05',
    logicalCallId: '49520531-9c09-4915-8c40-7599c4385753',
  }
  try {
    expect(hub.isAccountEnabled()).toBe(true)
    expect(await hub.listTools('office')).toHaveLength(1)
    await hub.setAccountEnabled(false)
    expect(hub.status().find((status) => status.name === 'office')).toMatchObject({
      enabled: false,
      connected: false,
      toolCount: 0,
    })
    expect(hub.alwaysAvailableServers()).toEqual(['custom'])
    const managedRequests = requests.filter((method) => method.startsWith('Bearer')).length
    await expect(hub.listTools('office')).rejects.toThrow('account:mcp-disabled')
    expect(await hub.callTool('office', 'search', {}, context)).toMatchObject({ isError: true })
    expect(requests.filter((method) => method.startsWith('Bearer'))).toHaveLength(managedRequests)
    expect(await hub.listTools('custom')).toHaveLength(1)
    expect(await hub.callTool('custom', 'search', {})).toEqual({
      text: 'local-success',
      isError: false,
    })
    await hub.setAccountEnabled(true)
    expect(await hub.listTools('office')).toHaveLength(1)
    expect(await hub.callTool('office', 'search', {}, context)).toEqual({
      text: 'local-success',
      isError: false,
    })
    expect(requests.filter((method) => method === 'Bearer fixture-token:initialize')).toHaveLength(
      2,
    )
    expect(requests.filter((method) => method === 'Bearer fixture-token:tools/call')).toHaveLength(
      1,
    )
  } finally {
    await hub.shutdown()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

it('does not send a managed request whose token arrives after the user disables MCP', async () => {
  let refreshCanPersist = false
  let resumeToken!: (token: string) => void
  let tokenEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    tokenEntered = resolve
  })
  const token = new Promise<string>((resolve) => {
    resumeToken = resolve
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method !== 'POST') return new Response(null, { status: 405 })
    const rpc = JSON.parse(String(init.body)) as { id?: number }
    if (rpc.id === undefined) return new Response(null, { status: 202 })
    return Response.json({
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'local-fixture', version: '1' },
      },
    })
  })
  const hub = new McpHub(
    {
      office: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
      },
    },
    {
      account: {
        apiBase: () => 'https://fixture.invalid',
        bind: () => ({ userId: 'fixture', sessionId: 1, signal: new AbortController().signal }),
        isCurrent: () => true,
        token: async (binding) => {
          tokenEntered()
          const refreshed = await token
          refreshCanPersist = !binding.signal.aborted
          return refreshed
        },
      },
    },
  )
  try {
    const discovery = hub.listTools('office')
    const failure = expect(discovery).rejects.toThrow()
    await entered
    await hub.setAccountEnabled(false)
    resumeToken('fixture-token')
    await failure
    expect(fetch).not.toHaveBeenCalled()
    expect(refreshCanPersist).toBe(true)
  } finally {
    await hub.shutdown()
    fetch.mockRestore()
  }
})
