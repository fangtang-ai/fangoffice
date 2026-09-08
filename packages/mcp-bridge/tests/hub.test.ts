import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { McpHub } from '../src/hub'

const ECHO_SERVER = join(__dirname, 'echo-server.mjs')

const hub = new McpHub({
  echo: {
    transport: 'stdio',
    command: process.execPath,
    args: [ECHO_SERVER],
    enabled: true,
    alwaysAvailable: true,
    timeoutMs: 15_000,
  },
  absent: {
    transport: 'stdio',
    command: 'this-binary-does-not-exist',
    enabled: true,
  },
  off: { transport: 'stdio', command: 'ignored', enabled: false },
})

afterAll(async () => {
  await hub.shutdown()
})

describe('McpHub against a real stdio server', () => {
  it('lists the server tools', async () => {
    const tools = await hub.listTools('echo')
    expect(tools.map((t) => t.name)).toEqual(['echo'])
    expect(tools[0]!.inputSchema).toMatchObject({ type: 'object' })
  })

  it('calls a tool and returns its text content', async () => {
    const result = await hub.callTool('echo', 'echo', { message: 'hello 方塘' })
    expect(result).toEqual({ text: 'echo:hello 方塘', isError: false })
  })

  it('surfaces isError results and connection failures as error results', async () => {
    const deliberate = await hub.callTool('echo', 'fail', {})
    expect(deliberate.isError).toBe(true)

    const dead = await hub.callTool('absent', 'anything', {})
    expect(dead.isError).toBe(true)
    expect(dead.text).toBeTruthy()
  })

  it('reports status and filters disabled servers out of the registry', () => {
    const status = hub.status()
    expect(status.map((s) => s.name).sort()).toEqual(['absent', 'echo'])
    expect(status.find((s) => s.name === 'echo')).toMatchObject({
      enabled: true,
      alwaysAvailable: true,
      connected: true,
      toolCount: 1,
    })
    expect(hub.hasServer('off')).toBe(false)
    expect(hub.alwaysAvailableServers()).toEqual(['echo'])
  })
})
