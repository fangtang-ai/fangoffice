import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'office-free-mcp-diagnostic', version: '1.0.0' })
let callCount = 0
server.registerTool(
  'diagnostic_ping',
  {
    description: 'Free local protocol diagnostic; no credentials or network access',
    inputSchema: {},
  },
  async () => {
    callCount += 1
    return { content: [{ type: 'text', text: `diagnostic-pong:${callCount}` }] }
  },
)
await server.connect(new StdioServerTransport())
