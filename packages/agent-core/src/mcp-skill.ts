import type { AgentToolDef } from './types'
import type { PresetSkillHooks } from './preset'

/**
 * Renderer-side bridge between the chat's preset skill and the main-process
 * MCP hub (channels mcp:status / mcp:list-tools / mcp:call-tool, exposed by
 * each app's preload). Pure TypeScript — no SDK import in the renderer.
 */

export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  alwaysAvailable: boolean
  connected: boolean
  toolCount: number
  error?: string
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  text: string
  isError: boolean
}

export interface McpRendererApi {
  status(): Promise<McpServerInfo[]>
  listTools(server: string): Promise<McpToolInfo[]>
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>
}

export const MCP_TOOL_PREFIX = 'mcp__'

export const mcpToolName = (server: string, tool: string): string =>
  `${MCP_TOOL_PREFIX}${server}__${tool}`

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/**
 * Cache TTL for tool listings: skill.tools is re-read before every model
 * request, so the per-turn IPC cost must stay flat. One in-flight refresh at
 * a time; the synchronous getter serves the last completed snapshot.
 */
const TOOL_CACHE_TTL_MS = 30_000

/**
 * Preset-skill hooks backed by the MCP hub: the active preset's `mcpServers`
 * plus every always-available server contribute tool defs, and tool calls
 * route back over IPC. Failures degrade to "no tools" / error results — a
 * dead internal service must not break the chat.
 */
export function createMcpPresetHooks(api: McpRendererApi): PresetSkillHooks {
  const toolCache = new Map<string, { tools: McpToolInfo[]; fetchedAt: number }>()
  let alwaysServers: string[] | null = null
  let snapshot: { key: string; tools: AgentToolDef[] } = { key: '', tools: [] }
  let inFlight: Promise<void> | null = null

  async function loadAlwaysServers(): Promise<string[]> {
    if (alwaysServers) return alwaysServers
    try {
      const status = await api.status()
      alwaysServers = status.filter((s) => s.alwaysAvailable && s.enabled).map((s) => s.name)
    } catch {
      alwaysServers = []
    }
    return alwaysServers
  }

  async function toolsOf(server: string): Promise<McpToolInfo[]> {
    const cached = toolCache.get(server)
    if (cached && Date.now() - cached.fetchedAt < TOOL_CACHE_TTL_MS) return cached.tools
    try {
      const tools = await api.listTools(server)
      toolCache.set(server, { tools, fetchedAt: Date.now() })
      return tools
    } catch {
      toolCache.set(server, { tools: [], fetchedAt: Date.now() })
      return []
    }
  }

  async function refresh(presetServers: string[]): Promise<void> {
    const always = await loadAlwaysServers()
    const servers = [...new Set([...always, ...presetServers])].filter((s) =>
      /^[A-Za-z0-9_-]+$/.test(s),
    )
    const lists = await Promise.all(servers.map((server) => toolsOf(server)))
    const tools: AgentToolDef[] = []
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i]!
      for (const tool of lists[i] ?? []) {
        tools.push({
          name: mcpToolName(server, tool.name),
          description: `[${server} MCP] ${tool.description ?? tool.name}`,
          inputSchema: tool.inputSchema,
        })
      }
    }
    snapshot = { key: [...always, ...presetServers].join(','), tools }
  }

  return {
    getTools: (presetServers: string[]) => {
      if (!inFlight) {
        inFlight = refresh(presetServers)
          .catch(() => {})
          .finally(() => {
            inFlight = null
          })
      }
      const key = [...(alwaysServers ?? []), ...presetServers].join(',')
      return snapshot.key === key ? snapshot.tools : []
    },
    executeTool: async (call, signal) => {
      const parsed = parseMcpToolName(call.name)
      if (!parsed) return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
      if (signal?.aborted) {
        return { output: 'stopped by the user', isError: true, summary: parsed.tool }
      }
      const result = await api.callTool(parsed.server, parsed.tool, call.input)
      return {
        output: result.text || '(empty result)',
        isError: result.isError,
        summary: `${parsed.server}:${parsed.tool}`,
      }
    },
    describeTools: (tools) => {
      if (tools.length === 0) return ''
      return (
        '\n\n## Additional tools from the organization (MCP)\n' +
        'These tools call internal systems. Prefer them when the request touches those systems; ' +
        'pass only the arguments each schema asks for, never invent values:\n' +
        tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
      )
    },
  }
}
