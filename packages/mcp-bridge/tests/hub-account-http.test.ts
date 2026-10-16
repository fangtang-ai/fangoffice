import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { McpHub } from '../src/hub'

it('uses the real SDK and loopback HTTP to refresh once, initialize and call a managed tool', async () => {
  const requests: Array<{ path: string; authorization: string; method: string }> = []
  const server = createServer(async (request, response) => {
    requests.push({
      path: request.url ?? '',
      authorization: request.headers.authorization ?? '',
      method: request.method ?? '',
    })
    if (request.headers.authorization === 'Bearer expired-fixture') {
      response.writeHead(401).end()
      return
    }
    if (request.method === 'GET') {
      response.writeHead(405).end()
      return
    }
    let text = ''
    for await (const chunk of request) text += String(chunk)
    const rpc = JSON.parse(text) as { id?: number; method?: string }
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
        : { content: [{ type: 'text', text: 'local-success' }] }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const binding = { userId: 'local-A', sessionId: 1, signal: new AbortController().signal }
  let token = 'expired-fixture'
  let renewals = 0
  const hub = new McpHub(
    {
      policy: {
        transport: 'http',
        auth: 'fangtang-account',
        enabled: true,
        url: '${ACCOUNT_API_BASE}/api/office/mcp',
      },
    },
    {
      account: {
        apiBase: () => `http://127.0.0.1:${address.port}/api`,
        allowLoopback: true,
        bind: () => binding,
        isCurrent: () => true,
        token: async (_binding, rejected) => {
          if (rejected === token) {
            token = 'renewed-fixture'
            renewals++
          }
          return token
        },
      },
    },
  )
  try {
    expect(
      await hub.callTool(
        'policy',
        'search',
        {},
        {
          aiRunId: 'f4245812-731b-43e0-a1b4-ef2810140b05',
          logicalCallId: '49520531-9c09-4915-8c40-7599c4385753',
        },
      ),
    ).toEqual({
      text: 'local-success',
      isError: false,
    })
    expect(renewals).toBe(1)
    expect(requests[0]?.authorization).toBe('Bearer expired-fixture')
    expect(
      requests.slice(1).every((request) => request.authorization === 'Bearer renewed-fixture'),
    ).toBe(true)
    expect(requests.every((request) => request.path === '/api/office/mcp')).toBe(true)
  } finally {
    await hub.shutdown()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
