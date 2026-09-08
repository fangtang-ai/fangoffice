import { describe, expect, it } from 'vitest'
import {
  createMcpPresetHooks,
  mcpToolName,
  parseMcpToolName,
  type McpCallResult,
  type McpRendererApi,
  type McpServerInfo,
  type McpToolInfo,
} from '../src/mcp-skill'
import type { AgentToolDef } from '../src/types'

describe('mcp tool naming', () => {
  it('round-trips server and tool through the prefixed name', () => {
    const name = mcpToolName('crm', 'lookup_account')
    expect(name).toBe('mcp__crm__lookup_account')
    expect(parseMcpToolName(name)).toEqual({ server: 'crm', tool: 'lookup_account' })
  })

  it('rejects non-MCP and malformed names', () => {
    expect(parseMcpToolName('web_search')).toBeNull()
    expect(parseMcpToolName('mcp__noseparator')).toBeNull()
    expect(parseMcpToolName('mcp__a__')).toBeNull()
  })
})

function fakeApi(
  servers: McpServerInfo[],
  tools: Record<string, McpToolInfo[]>,
  calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [],
): McpRendererApi {
  return {
    status: async () => servers,
    listTools: async (server: string) => tools[server] ?? [],
    callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ server, tool, args })
      return { text: `ok:${tool}`, isError: false } satisfies McpCallResult
    },
  }
}

describe('createMcpPresetHooks', () => {
  it('merges always-available servers with the preset servers into tool defs', async () => {
    const hooks = createMcpPresetHooks(
      fakeApi(
        [{ name: 'wiki', transport: 'http', enabled: true, alwaysAvailable: true, connected: false, toolCount: 0 }],
        {
          wiki: [{ name: 'search', description: 'Search the wiki', inputSchema: { type: 'object' } }],
          crm: [{ name: 'lookup', inputSchema: { type: 'object' } }],
        },
      ),
    )
    const tools: AgentToolDef[] = hooks.getTools!([])
    // first call returns the (empty) snapshot and kicks off the refresh
    expect(tools).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    const settled = hooks.getTools!([])
    expect(settled.map((t) => t.name)).toEqual(['mcp__wiki__search'])

    await new Promise((r) => setTimeout(r, 0))
    const withPreset = hooks.getTools!(['crm'])
    await new Promise((r) => setTimeout(r, 0))
    expect(hooks.getTools!(['crm']).map((t) => t.name).sort()).toEqual([
      'mcp__crm__lookup',
      'mcp__wiki__search',
    ])
    void withPreset
  })

  it('routes executeTool over the API and reports errors as results', async () => {
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = []
    const hooks = createMcpPresetHooks(fakeApi([], { crm: [] }, calls))
    const result = await hooks.executeTool!({ id: 'c', name: 'mcp__crm__lookup', input: { id: 7 } })
    expect(result).toMatchObject({ output: 'ok:lookup', isError: false, summary: 'crm:lookup' })
    expect(calls).toEqual([{ server: 'crm', tool: 'lookup', args: { id: 7 } }])

    const failApi = fakeApi([], {}, [])
    failApi.callTool = async (): Promise<McpCallResult> => ({ text: 'boom', isError: true })
    const failing = createMcpPresetHooks(failApi)
    const bad = await failing.executeTool!({ id: 'c', name: 'mcp__crm__boom', input: {} })
    expect(bad).toMatchObject({ isError: true })

    const unknown = await hooks.executeTool!({ id: 'c', name: 'web_search', input: {} })
    expect(unknown.isError).toBe(true)
  })

  it('describeTools renders a prompt section only when tools exist', () => {
    const hooks = createMcpPresetHooks(fakeApi([], {}, []))
    const empty = hooks.describeTools!([])
    expect(empty).toBe('')
    const section = hooks.describeTools!([
      { name: 'mcp__crm__lookup', description: '[crm MCP] lookup', inputSchema: { type: 'object' } },
    ])
    expect(section).toContain('MCP')
    expect(section).toContain('mcp__crm__lookup')
  })
})
