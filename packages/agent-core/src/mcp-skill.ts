import type { AgentToolDef } from './types'
import type { PresetSkillHooks } from './preset'
import type { McpBillingInfo, McpCallContext } from './billing'

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
  billingProduct?: 'policy_mcp'
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  text: string
  isError: boolean
  billing?: McpBillingInfo
}

export interface McpPaidCallGateInfo {
  aiRunId: string
  /** paid managed calls already made in this run (failed ones included) */
  used: number
  /** per-run budget before this confirmation */
  max: number
}

export interface McpPaidCallDisclosureInfo {
  aiRunId: string
}

export interface McpRendererApi {
  status(): Promise<McpServerInfo[]>
  listTools(server: string): Promise<McpToolInfo[]>
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    context?: McpCallContext,
  ): Promise<McpCallResult>
  /** first-use price disclosure before a run's first paid call; resolve false (or omit) to decline */
  onPaidCallDisclosure?(info: McpPaidCallDisclosureInfo): Promise<boolean>
  /** pause-and-confirm gate when a run's paid-call budget is exhausted; resolve false (or omit) to decline */
  onPaidCallLimit?(info: McpPaidCallGateInfo): Promise<boolean>
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
/** §6.3 trial default; overridable via createMcpPresetHooks options */
const DEFAULT_MAX_PAID_CALLS_PER_RUN = 10
/** finished-run budget entries kept before the oldest is evicted */
const MAX_TRACKED_RUNS = 64

/**
 * Preset-skill hooks backed by the MCP hub: the active preset's `mcpServers`
 * plus every always-available server contribute tool defs, and tool calls
 * route back over IPC. Failures degrade to "no tools" / error results — a
 * dead internal service must not break the chat.
 */
export function createMcpPresetHooks(
  api: McpRendererApi,
  options?: { maxPaidMcpCallsPerRun?: number },
): PresetSkillHooks {
  const toolCache = new Map<string, { tools: McpToolInfo[]; fetchedAt: number }>()
  let alwaysServers: string[] | null = null
  let paidServers: Set<string> = new Set()
  let statusFetchedAt = 0
  // per-run paid-call budget: failed calls count too; retries stay inside one callTool await so
  // they cannot double-count. Insertion-ordered map doubles as an LRU cap for finished runs.
  const runBudget = new Map<
    string,
    { used: number; allowance: number; disclosed: boolean; declined: boolean }
  >()
  const maxPaidCalls = Math.max(0, options?.maxPaidMcpCallsPerRun ?? DEFAULT_MAX_PAID_CALLS_PER_RUN)
  let snapshot: { key: string; tools: AgentToolDef[] } = { key: '', tools: [] }
  let inFlight: Promise<void> | null = null

  async function loadAlwaysServers(): Promise<string[]> {
    // same TTL as the tool listings: one status IPC per rebuild keeps the per-turn cost flat,
    // while still picking up mid-session login/paid-server changes within 30s
    if (alwaysServers && Date.now() - statusFetchedAt < TOOL_CACHE_TTL_MS) return alwaysServers
    try {
      const status = await api.status()
      alwaysServers = status.filter((s) => s.alwaysAvailable && s.enabled).map((s) => s.name)
      paidServers = new Set(
        status.filter((s) => s.enabled && s.billingProduct === 'policy_mcp').map((s) => s.name),
      )
      statusFetchedAt = Date.now()
      return alwaysServers
    } catch {
      // fail open: the server-side wallet remains the authority for money. Keep the last known
      // lists (if any) so one transient failure does not disable the gate for the whole session;
      // an unknown first state is retried on the next cache rebuild.
      return alwaysServers ?? []
    }
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
    executeTool: async (call, signal, context) => {
      const parsed = parseMcpToolName(call.name)
      if (!parsed)
        return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
      if (signal?.aborted) {
        return { output: 'stopped by the user', isError: true, summary: parsed.tool }
      }
      if (context) {
        // ensure paidServers is known before gating; real loop paths always call getTools first,
        // so this only fires for direct executeTool use before any model request
        if (alwaysServers === null) await loadAlwaysServers()
        if (paidServers.has(parsed.server)) {
          const budget = runBudget.get(context.aiRunId) ?? {
            used: 0,
            allowance: maxPaidCalls,
            disclosed: false,
            declined: false,
          }
          if (runBudget.size >= MAX_TRACKED_RUNS && !runBudget.has(context.aiRunId)) {
            const oldest = runBudget.keys().next().value
            if (oldest !== undefined) runBudget.delete(oldest)
          }
          runBudget.set(context.aiRunId, budget)
          if (budget.declined) {
            return {
              output:
                'The user declined the paid-call price disclosure; no further paid MCP calls are allowed in this run.',
              isError: true,
              summary: parsed.tool,
            }
          }
          if (!budget.disclosed) {
            // set before the await so concurrent first calls prompt at most once
            budget.disclosed = true
            const allowed = api.onPaidCallDisclosure
              ? await api.onPaidCallDisclosure({ aiRunId: context.aiRunId })
              : false
            if (!allowed) {
              budget.declined = true
              return {
                output:
                  'The user declined the paid-call price disclosure; no further paid MCP calls are allowed in this run.',
                isError: true,
                summary: parsed.tool,
              }
            }
          }
          if (budget.used >= budget.allowance) {
            const allowed = api.onPaidCallLimit
              ? await api.onPaidCallLimit({
                  aiRunId: context.aiRunId,
                  used: budget.used,
                  max: budget.allowance,
                })
              : false
            if (!allowed) {
              return {
                output:
                  'This task paid-call budget is exhausted and the user declined to raise it; no further paid MCP calls are allowed in this run.',
                isError: true,
                summary: parsed.tool,
              }
            }
            budget.allowance += maxPaidCalls
          }
          // re-check after the gate await: a cancelled run must not spend
          if (signal?.aborted) {
            return { output: 'stopped by the user', isError: true, summary: parsed.tool }
          }
          // reserve synchronously so concurrent executeTool calls cannot lose a count
          budget.used += 1
        }
      }
      const result = context
        ? await api.callTool(parsed.server, parsed.tool, call.input, context)
        : await api.callTool(parsed.server, parsed.tool, call.input)
      return {
        output: result.text || '(empty result)',
        isError: result.isError,
        summary: `${parsed.server}:${parsed.tool}`,
        ...(result.billing ? { billing: result.billing } : {}),
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
