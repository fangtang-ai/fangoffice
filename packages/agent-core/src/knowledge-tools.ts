import type { AgentToolDef } from './types'

export const KNOWLEDGE_TOOLS: AgentToolDef[] = [
  {
    name: 'list_knowledge_documents',
    description:
      'List the current account’s cloud files and published/not-ready state in one knowledge space. Follow nextCursor to inspect later pages; do not use semantic search to decide whether a file exists.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: { type: 'string', description: 'Knowledge space ID from the catalog.' },
        cursor: {
          type: 'string',
          description: 'nextCursor from the previous page; omit on the first page.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Page size, default 20.',
        },
      },
      required: ['spaceId'],
    },
  },
  {
    name: 'list_knowledge_spaces',
    description:
      'Discover the current account’s knowledge spaces before listing files or searching. Follow nextCursor to inspect more spaces.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'get_knowledge_status',
    description:
      'Read the actual processing phase/error of a file’s desired.operationId from list_knowledge_documents. Use this before describing an unready file as processing or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: { type: 'string' },
        documentId: { type: 'string' },
        operationId: { type: 'string' },
      },
      required: ['spaceId', 'documentId', 'operationId'],
    },
  },
  {
    name: 'search_knowledge',
    description:
      'Semantically retrieve passages from the current account’s published cloud documents. Specify spaces or documents found in the catalog, then read the returned citation IDs for original evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 1024 },
        scope: {
          type: 'object',
          description:
            'Use kind=spaces with spaceIds, or kind=documents with documents. IDs must come from the account catalog.',
          properties: {
            kind: { type: 'string', enum: ['spaces', 'documents'] },
            spaceIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 100,
            },
            documents: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  spaceId: { type: 'string' },
                  documentId: { type: 'string' },
                },
                required: ['spaceId', 'documentId'],
              },
              minItems: 1,
              maxItems: 100,
            },
          },
          required: ['kind'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 5.' },
      },
      required: ['query', 'scope'],
    },
  },
  {
    name: 'read_knowledge_source',
    description:
      'Read an original passage and its verifiable file/version/build locator using a citationId returned by search_knowledge. Follow nextOffset to read long passages. Never guess a citation ID.',
    inputSchema: {
      type: 'object',
      properties: {
        citationId: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['citationId'],
    },
  },
]
