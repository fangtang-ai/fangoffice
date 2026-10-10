/**
 * McpHub: one connection per configured server, connected lazily on first
 * tool listing/call and kept alive for the session. stdio children die with
 * the main process; HTTP sessions are closed explicitly on shutdown().
 *
 * The hub never throws into the caller's happy path: connection failures
 * surface as `error` on the server's status and as error results on calls, so
 * one dead internal service must not take the AI chat down with it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { McpServerConfig } from './config'
import { isMcpCallContext, type McpBillingInfo, type McpCallContext } from '@genoffice/agent-core'
import { MCP_BILLING_META_KEY, formatMcpResult, mcpProblemText } from './billing-result'
import {
  AccountMcpError,
  assertAccountMcpBinding,
  createAccountMcpFetch,
  resolveAccountMcpUrl,
  type AccountMcpAccess,
  type AccountMcpBinding,
} from './account-http'

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  alwaysAvailable: boolean
  connected: boolean
  toolCount: number
  /** last connection/call failure (cleared on a successful operation) */
  error?: string
  billingProduct?: 'policy_mcp'
}

export interface McpToolInfo {
  name: string
  description?: string
  /** JSON Schema for the tool input */
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  /** concatenated text content (non-text blocks JSON-stringified) */
  text: string
  isError: boolean
  billing?: McpBillingInfo
}

const CONNECT_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 15_000
const APP_NAME = '方塘Office'
const APP_VERSION = '0.1.0'

interface Connection {
  client: Client
  tools: McpToolInfo[]
  binding?: AccountMcpBinding
}

export class McpHub {
  private readonly servers = new Map<string, McpServerConfig>()
  private readonly connections = new Map<string, Connection>()
  private readonly pendingConnections = new Map<string, Promise<Connection>>()
  private accountGeneration = 0
  private stopped = false
  private readonly unsubscribe: (() => void) | undefined
  /** per-server call timeout override */
  private readonly timeouts = new Map<string, number>()

  constructor(
    config: Record<string, McpServerConfig>,
    private readonly options: { account?: AccountMcpAccess } = {},
  ) {
    for (const [name, cfg] of Object.entries(config)) {
      if (!cfg.enabled) continue
      this.servers.set(name, cfg)
      this.timeouts.set(name, cfg.timeoutMs ?? 30_000)
    }
    this.unsubscribe = options.account?.subscribe?.(() => {
      void this.closeAccountConnections()
    })
  }

  /** Servers whose tools join every chat (in config order). */
  alwaysAvailableServers(): string[] {
    return [...this.servers.entries()]
      .filter(([, cfg]) => cfg.alwaysAvailable)
      .map(([name]) => name)
  }

  hasServer(name: string): boolean {
    return this.servers.has(name)
  }

  private async connect(name: string): Promise<Connection> {
    if (this.stopped) throw new Error('MCP hub stopped')
    const cfg = this.servers.get(name)
    if (!cfg) throw new Error(`Unknown MCP server: ${name}`)
    const existing = this.connections.get(name)
    if (existing) {
      if (existing.binding) assertAccountMcpBinding(this.options.account!, existing.binding)
      return existing
    }
    const pending = this.pendingConnections.get(name)
    if (pending) return pending
    const loading = this.openConnection(name, cfg)
    this.pendingConnections.set(name, loading)
    try {
      return await loading
    } finally {
      if (this.pendingConnections.get(name) === loading) this.pendingConnections.delete(name)
    }
  }

  private async openConnection(name: string, cfg: McpServerConfig): Promise<Connection> {
    const generation = this.accountGeneration
    if (cfg.auth === 'fangtang-account' && !this.options.account)
      throw new AccountMcpError('account:required')
    const binding = cfg.auth === 'fangtang-account' ? this.options.account!.bind() : undefined
    const client = new Client({ name: APP_NAME, version: APP_VERSION })
    try {
      if (cfg.transport === 'http') {
        const url =
          cfg.auth === 'fangtang-account'
            ? resolveAccountMcpUrl(cfg.url!, this.options.account!)
            : new URL(cfg.url!)
        // the SDK's own types are not exactOptionalPropertyTypes-clean
        const transport = new StreamableHTTPClientTransport(url, {
          ...(binding
            ? {
                fetch: createAccountMcpFetch(url, this.options.account!, binding),
                reconnectionOptions: {
                  maxRetries: 0,
                  maxReconnectionDelay: 0,
                  initialReconnectionDelay: 0,
                  reconnectionDelayGrowFactor: 1,
                },
              }
            : {}),
          requestInit: {
            ...(cfg.headers ? { headers: cfg.headers } : {}),
          },
        }) as unknown as Transport
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${name}`)
      } else {
        const transport = new StdioClientTransport({
          command: cfg.command!,
          args: cfg.args ?? [],
          env: { ...(cfg.env ?? {}) },
        })
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${name}`)
      }
      if (this.stopped || (binding && generation !== this.accountGeneration))
        throw new AccountMcpError('account:changed')
      if (binding) assertAccountMcpBinding(this.options.account!, binding)
      const connection: Connection = { client, tools: [], ...(binding ? { binding } : {}) }
      this.connections.set(name, connection)
      return connection
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
  }

  /** Cached tool definitions for one server (fetches on first use). */
  async listTools(name: string): Promise<McpToolInfo[]> {
    const connection = await this.connect(name)
    if (connection.tools.length > 0) return connection.tools
    const options: RequestOptions = {}
    const timeout = this.timeouts.get(name)
    if (timeout !== undefined) options.timeout = timeout
    const response = await withTimeout(
      connection.client.listTools(undefined, options),
      LIST_TIMEOUT_MS,
      `list tools of ${name}`,
    )
    if (connection.binding) assertAccountMcpBinding(this.options.account!, connection.binding)
    connection.tools = (response.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }))
    return connection.tools
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    context?: McpCallContext,
  ): Promise<McpCallResult> {
    if (this.servers.get(server)?.auth === 'fangtang-account' && !isMcpCallContext(context))
      return { text: 'invalid_call_metadata', isError: true }
    let connection: Connection | undefined
    try {
      connection = await this.connect(server)
      // the SDK's RequestOptions is not exactOptionalPropertyTypes-clean
      const options: RequestOptions = {}
      const timeout = this.timeouts.get(server)
      if (timeout !== undefined) options.timeout = timeout
      if (connection.binding) options.signal = connection.binding.signal
      const result = await connection.client.callTool(
        {
          name: tool,
          arguments: args,
          ...(connection.binding && context ? { _meta: { [MCP_BILLING_META_KEY]: context } } : {}),
        },
        undefined,
        options,
      )
      if (connection.binding) assertAccountMcpBinding(this.options.account!, connection.binding)
      return formatMcpResult(result, connection.binding ? context : undefined)
    } catch (error) {
      return this.failedCall(server, connection, error, context)
    }
  }

  private async failedCall(
    server: string,
    connection: Connection | undefined,
    error: unknown,
    context?: McpCallContext,
  ): Promise<McpCallResult> {
    // a crashed/lamed server must not wedge the session: drop the connection
    // so the next call reconnects fresh
    if (connection && this.connections.get(server) === connection) {
      this.connections.delete(server)
      await connection.client.close().catch(() => undefined)
    }
    const managed = this.servers.get(server)?.auth === 'fangtang-account'
    const problem =
      error instanceof AccountMcpError && error.problem
        ? error.problem
        : {
            code: error instanceof AccountMcpError ? error.code : 'account:request-failed',
            retryAllowed:
              error instanceof AccountMcpError && error.code === 'account:request-failed',
          }
    return {
      text: managed
        ? error instanceof AccountMcpError && !error.problem
          ? error.code
          : mcpProblemText(problem)
        : error instanceof Error
          ? error.message
          : String(error),
      isError: true,
      ...(managed && context
        ? { billing: { ...context, product: 'policy_mcp' as const, error: problem } }
        : {}),
    }
  }

  status(): McpServerStatus[] {
    return [...this.servers.entries()].map(([name, cfg]) => {
      const connection = this.connections.get(name)
      return {
        name,
        transport: cfg.transport,
        enabled: cfg.enabled !== false,
        alwaysAvailable: cfg.alwaysAvailable === true,
        connected: connection !== undefined,
        toolCount: connection?.tools.length ?? 0,
        ...(cfg.auth === 'fangtang-account' ? { billingProduct: 'policy_mcp' as const } : {}),
      }
    })
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    const closing = [...this.connections.values()].map((connection) =>
      connection.client.close().catch(() => {}),
    )
    this.connections.clear()
    await Promise.all(closing)
  }

  private async closeAccountConnections() {
    this.accountGeneration++
    const closing: Promise<void>[] = []
    for (const [name, cfg] of this.servers) {
      if (cfg.auth !== 'fangtang-account') continue
      this.pendingConnections.delete(name)
      const connection = this.connections.get(name)
      this.connections.delete(name)
      if (connection) closing.push(connection.client.close().catch(() => undefined))
    }
    await Promise.all(closing)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP ${what} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
