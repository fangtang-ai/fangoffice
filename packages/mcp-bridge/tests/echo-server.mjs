import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fileURLToPath } from 'node:url'

// Minimal stdio MCP server used by hub.test.ts: one `echo` tool.
const server = new Server({ name: 'echo-server', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes the message back',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'text to echo' } },
        required: ['message'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'fail') {
    return { isError: true, content: [{ type: 'text', text: 'deliberate failure' }] }
  }
  const message = String(request.params.arguments?.message ?? '')
  return { content: [{ type: 'text', text: `echo:${message}` }] }
})

await server.connect(new StdioServerTransport())
// keep the process alive until the client closes the stdio stream
if (process.send === undefined) {
  await new Promise(() => {})
}
void fileURLToPath
