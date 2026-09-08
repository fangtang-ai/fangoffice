import { describe, expect, it } from 'vitest'
import { loadMcpConfig } from '../src/config'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function writeConfig(dir: string, name: string, body: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(body))
  return path
}

describe('loadMcpConfig', () => {
  it('parses a valid config with both transports and defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    const path = writeConfig(dir, 'm.json', {
      mcpServers: {
        erp: { transport: 'stdio', command: '/usr/local/bin/erp', args: ['--mode', 'cli'], env: { ERP_KEY: 'k' } },
        wiki: { transport: 'http', url: 'https://wiki.internal/mcp', headers: { Authorization: 'Bearer t' }, alwaysAvailable: true, timeoutMs: 5000 },
        off: { transport: 'stdio', command: 'x', enabled: false },
      },
    })
    const { servers } = loadMcpConfig(path)
    expect(Object.keys(servers).sort()).toEqual(['erp', 'off', 'wiki'])
    expect(servers.erp).toMatchObject({ transport: 'stdio', enabled: true, alwaysAvailable: false })
    expect(servers.wiki).toMatchObject({
      transport: 'http',
      alwaysAvailable: true,
      timeoutMs: 5000,
      enabled: true,
    })
  })

  it('skips malformed server entries without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    const path = writeConfig(dir, 'm.json', {
      mcpServers: {
        broken_stdio: { transport: 'stdio' },
        broken_http: { transport: 'http' },
        not_an_object: 'oops',
        good: { transport: 'stdio', command: 'ok' },
      },
      otherTopLevel: true,
    })
    const { servers } = loadMcpConfig(path)
    expect(Object.keys(servers)).toEqual(['good'])
  })

  it('treats a missing or corrupt file as an empty config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    expect(loadMcpConfig(join(dir, 'missing.json')).servers).toEqual({})
    const corrupt = join(dir, 'c.json')
    writeFileSync(corrupt, '{not json')
    expect(loadMcpConfig(corrupt).servers).toEqual({})
  })

  it('user-level config overrides bundled entries by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    const bundled = writeConfig(dir, 'bundled.json', {
      mcpServers: {
        erp: { transport: 'stdio', command: 'bundled-erp' },
        wiki: { transport: 'http', url: 'https://bundled.example/wiki' },
      },
    })
    const user = writeConfig(dir, 'user.json', {
      mcpServers: {
        erp: { transport: 'stdio', command: 'user-erp' },
        extra: { transport: 'http', url: 'https://extra.example' },
      },
    })
    const { servers } = loadMcpConfig(bundled, user)
    expect(servers.erp!.command).toBe('user-erp')
    expect(servers.wiki!.url).toBe('https://bundled.example/wiki')
    expect(servers.extra).toBeDefined()
  })
})

describe('expandEnvRefs via loadMcpConfig', () => {
  it('expands ${VAR} in url, headers, command, args and child env', () => {
    process.env.MCP_TEST_TOKEN = 'tok-123'
    process.env.MCP_TEST_HOST = 'internal.example'
    process.env.MCP_TEST_CMD = 'C:\\tools\\erp.exe'
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    const path = writeConfig(dir, 'm.json', {
      mcpServers: {
        wiki: {
          transport: 'http',
          url: 'https://\${MCP_TEST_HOST}/mcp',
          headers: { Authorization: 'Bearer \${MCP_TEST_TOKEN}' },
        },
        erp: {
          transport: 'stdio',
          command: '\${MCP_TEST_CMD}',
          args: ['--token', '\${MCP_TEST_TOKEN}'],
          env: { ERP_KEY: '\${MCP_TEST_TOKEN}' },
        },
      },
    })
    const { servers } = loadMcpConfig(path)
    expect(servers.wiki!.url).toBe('https://internal.example/mcp')
    expect(servers.wiki!.headers!.Authorization).toBe('Bearer tok-123')
    expect(servers.erp!.command).toBe('C:\\tools\\erp.exe')
    expect(servers.erp!.args).toEqual(['--token', 'tok-123'])
    expect(servers.erp!.env!.ERP_KEY).toBe('tok-123')
    delete process.env.MCP_TEST_TOKEN
    delete process.env.MCP_TEST_HOST
    delete process.env.MCP_TEST_CMD
  })

  it('expands unknown variables to empty strings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    const path = writeConfig(dir, 'm.json', {
      mcpServers: {
        wiki: { transport: 'http', url: 'https://x/\${MCP_TEST_MISSING}/y' },
      },
    })
    expect(loadMcpConfig(path).servers.wiki!.url).toBe('https://x//y')
  })
})
