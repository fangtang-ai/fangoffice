/**
 * MCP IPC surface for the AI chat (main process). Registered once per process
 * alongside the shared ai:* channels; the preload scripts pass through.
 *
 * Channels (all ipcMain.handle):
 * - mcp:status      → McpServerStatus[]            (configured servers + connection state)
 * - mcp:list-tools  → McpToolInfo[] for one server (lazily connects + caches)
 * - mcp:call-tool   → McpCallResult                (tool execution)
 */

import { ipcMain } from 'electron'
import { McpHub, type McpCallResult, type McpServerStatus, type McpToolInfo } from './hub'

export const MCP_CHANNELS = {
  status: 'mcp:status',
  listTools: 'mcp:list-tools',
  callTool: 'mcp:call-tool',
} as const

export function registerMcpIpc(hub: McpHub): void {
  ipcMain.handle(MCP_CHANNELS.status, (): McpServerStatus[] => hub.status())
  ipcMain.handle(MCP_CHANNELS.listTools, (_event, server: unknown): Promise<McpToolInfo[]> => {
    return hub.listTools(String(server))
  })
  ipcMain.handle(
    MCP_CHANNELS.callTool,
    async (_event, server: unknown, tool: unknown, args: unknown): Promise<McpCallResult> => {
      if (typeof tool !== 'string' || !tool) {
        return { text: 'mcp:call-tool requires a tool name', isError: true }
      }
      if (!hub.hasServer(String(server))) {
        return { text: `Unknown MCP server: ${String(server)}`, isError: true }
      }
      const input =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {}
      return hub.callTool(String(server), tool, input)
    },
  )
}
