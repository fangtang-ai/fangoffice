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

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  alwaysAvailable: boolean
  connected: boolean
  toolCount: number
  /** last connection/call failure (cleared on a successful operation) */
  error?: string
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
}

const CONNECT_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 15_000
const APP_NAME = '方塘Office'
const APP_VERSION = '0.1.0'

interface Connection {
  client: Client
  tools: McpToolInfo[]
}

export class McpHub {
  private readonly servers = new Map<string, McpServerConfig>()
  private readonly connections = new Map<string, Connection>()
  /** per-server call timeout override */
  private readonly timeouts = new Map<string, number>()

  constructor(config: Record<string, McpServerConfig>) {
    for (const [name, cfg] of Object.entries(config)) {
      if (!cfg.enabled) continue
      this.servers.set(name, cfg)
      this.timeouts.set(name, cfg.timeoutMs ?? 30_000)
    }
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
    const cfg = this.servers.get(name)
    if (!cfg) throw new Error(`Unknown MCP server: ${name}`)
    const existing = this.connections.get(name)
    if (existing) return existing
    const client = new Client({ name: APP_NAME, version: APP_VERSION })
    if (cfg.transport === 'http') {
      const url = new URL(cfg.url!)
      // the SDK's own types are not exactOptionalPropertyTypes-clean
      const transport = new StreamableHTTPClientTransport(url, {
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
    const connection: Connection = { client, tools: [] }
    this.connections.set(name, connection)
    return connection
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
  ): Promise<McpCallResult> {
    try {
      const connection = await this.connect(server)
      // the SDK's RequestOptions is not exactOptionalPropertyTypes-clean
      const options: RequestOptions = {}
      const timeout = this.timeouts.get(server)
      if (timeout !== undefined) options.timeout = timeout
      const result = await connection.client.callTool(
        { name: tool, arguments: args },
        undefined,
        options,
      )
      const isError = result.isError === true
      return { text: extractText(result.content), isError }
    } catch (error) {
      // a crashed/lamed server must not wedge the session: drop the connection
      // so the next call reconnects fresh
      this.connections.delete(server)
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      }
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
      }
    })
  }

  async shutdown(): Promise<void> {
    const closing = [...this.connections.values()].map((connection) =>
      connection.client.close().catch(() => {}),
    )
    this.connections.clear()
    await Promise.all(closing)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP ${what} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface McpContentBlock {
  type?: string
  text?: string
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts = content.map((block) => {
    const b = block as McpContentBlock
    if (typeof b?.text === 'string') return b.text
    if (b && typeof b === 'object') return JSON.stringify(b)
    return String(b ?? '')
  })
  return parts.filter(Boolean).join('\n')
}
