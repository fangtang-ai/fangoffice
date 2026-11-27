import { expect, it, vi } from 'vitest'
import { createKnowledgeSkill, type KnowledgeChatApi } from '../src'

const spaceId = '019a1234-0000-7000-8000-000000000001'
const documentId = '019a1234-0000-7000-8000-000000000002'
const versionId = '019a1234-0000-7000-8000-000000000003'
const buildId = '019a1234-0000-7000-8000-000000000004'
const operationId = '019a1234-0000-7000-8000-000000000005'
const title = '中原工学院关于新兴专业建设情况与对策建议.docx'
const sourceUnitId = '019a1234-0000-7000-8000-000000000006'
const sourceHash = 'a'.repeat(64)
const sourceText = '新兴专业建设需要加强师资队伍与产教融合。'

function fixtureApi() {
  return {
    session: vi.fn(async () => ({
      ok: true as const,
      value: { userId: 'account-A', sessionId: 1 },
    })),
    listSpaces: vi.fn(async () => ({
      ok: true as const,
      value: {
        items: [{ id: spaceId, title: '我的知识库', state: 'active' as const }],
        nextCursor: null,
      },
    })),
    listDocuments: vi.fn<KnowledgeChatApi['listDocuments']>(async () => ({
      ok: true as const,
      value: {
        items: [
          {
            id: documentId,
            spaceId,
            title,
            tags: [],
            purpose: 'facts' as const,
            generation: '1',
            active: null,
            desired: { operationId, versionId },
            deletedAt: null,
          },
        ],
        nextCursor: documentId,
      },
    })),
    getOperation: vi.fn<KnowledgeChatApi['getOperation']>(async () => ({
      ok: false,
      code: 'NOT_FOUND',
    })),
    search: vi.fn<KnowledgeChatApi['search']>(async () => ({
      ok: false,
      code: 'knowledge:request-failed',
    })),
    getSourceUnit: vi.fn<KnowledgeChatApi['getSourceUnit']>(async () => ({
      ok: false,
      code: 'NOT_FOUND',
    })),
    onSessionChanged: vi.fn(() => () => {}),
  } satisfies KnowledgeChatApi
}

it('lets ordinary chat discover an existing unready file and its next page without semantic search or MCP', async () => {
  const api = fixtureApi()
  const skill = createKnowledgeSkill(api)
  await skill.prepareTools?.()
  expect(skill.tools.some((tool) => tool.name === 'list_knowledge_documents')).toBe(true)
  const result = await skill.executeTool({
    id: 'catalog',
    name: 'list_knowledge_documents',
    input: { spaceId },
  })
  expect(result.isError).toBeFalsy()
  expect(JSON.parse(result.output)).toMatchObject({
    items: [{ id: documentId, title, status: 'not_ready', desired: { operationId, versionId } }],
    nextCursor: documentId,
  })
  expect(api.listDocuments).toHaveBeenCalledWith(1, spaceId, { limit: 20 })
  expect(api.search).not.toHaveBeenCalled()
  expect(skill.systemPrompt).toContain('not MCP')
})

it('keeps an existing published build searchable without claiming the desired operation is still updating', async () => {
  const api = fixtureApi()
  api.listDocuments.mockResolvedValue({
    ok: true,
    value: {
      items: [
        {
          id: documentId,
          spaceId,
          title,
          tags: [],
          purpose: 'facts',
          generation: '2',
          active: { versionId, buildId, treeBuildId: null },
          desired: { operationId, versionId },
          deletedAt: null,
        },
      ],
      nextCursor: null,
    },
  })
  const skill = createKnowledgeSkill(api)
  await skill.prepareTools?.()
  const result = await skill.executeTool({
    id: 'published',
    name: 'list_knowledge_documents',
    input: { spaceId },
  })
  expect(JSON.parse(result.output)).toMatchObject({
    items: [{ status: 'ready', active: { versionId, buildId }, desired: { operationId } }],
  })
})

it('retrieves an original DOCX passage with a stable citation and locator rather than treating a search snippet as the source', async () => {
  const api = fixtureApi()
  api.search.mockResolvedValue({
    ok: true,
    value: {
      runId: spaceId,
      callId: documentId,
      attemptId: versionId,
      indexProfileId: buildId,
      hits: [
        {
          spaceId,
          documentId,
          versionId,
          buildId,
          chunkId: operationId,
          title,
          chunkTextHash: sourceHash,
          distance: 0.2,
          snippet: { text: '需要加强师资队伍', startCp: 0, endCp: 8, chunkCodePointLength: 30 },
          sources: [{ sourceUnitId, startCp: 0, endCp: 30 }],
        },
      ],
    },
  })
  api.getSourceUnit.mockResolvedValue({
    ok: true,
    value: {
      id: sourceUnitId,
      spaceId,
      documentId,
      versionId,
      buildId,
      indexProfileId: spaceId,
      format: 'docx',
      sourceHash,
      parserRevision: 'docx-1',
      ordinal: 4,
      type: 'paragraph',
      text: sourceText,
      textHash: sourceHash,
      locator: {
        schemaVersion: 1,
        format: 'docx',
        sourceHash,
        textHash: sourceHash,
        span: { unit: 'unicode_code_point', origin: 0, start: 0, end: [...sourceText].length },
        headingPath: ['建设建议'],
        blockIndex: 4,
        table: null,
      },
      coverage: {
        schemaVersion: 1,
        format: 'docx',
        sourceHash,
        parserRevision: 'docx-1',
        scope: 'document',
        unit: 'block',
        status: 'unknown',
        expectedUnits: null,
        completedUnits: 0,
        missingUnits: null,
        excludedUnits: 0,
        warnings: [],
      },
      warnings: [],
    },
  })
  const skill = createKnowledgeSkill(api)
  await skill.prepareTools?.()
  const scope = { kind: 'documents', documents: [{ spaceId, documentId }] }
  const search = await skill.executeTool({
    id: 'search',
    name: 'search_knowledge',
    input: { query: '新兴专业建设的问题与对策', scope },
  })
  expect(search.isError).toBeFalsy()
  expect(api.search).toHaveBeenCalledWith(1, { query: '新兴专业建设的问题与对策', scope, limit: 5 })
  expect(JSON.parse(search.output)).toMatchObject({
    hits: [{ title, sources: [{ citationId: 'K1' }] }],
  })
  const source = await skill.executeTool({
    id: 'source',
    name: 'read_knowledge_source',
    input: { citationId: 'K1' },
  })
  expect(source.isError).toBeFalsy()
  expect(api.getSourceUnit).toHaveBeenCalledWith(1, {
    spaceId,
    documentId,
    versionId,
    buildId,
    sourceUnitId,
  })
  expect(JSON.parse(source.output)).toMatchObject({
    citationId: 'K1',
    title,
    text: sourceText,
    locator: { format: 'docx', blockIndex: 4, headingPath: ['建设建议'] },
    nextOffset: null,
  })
  expect(source.display).toMatchObject({ kind: 'text', text: expect.stringContaining(sourceText) })
})

it('discovers knowledge spaces and forwards pagination instead of silently searching only one space', async () => {
  const api = fixtureApi()
  const skill = createKnowledgeSkill(api)
  await skill.prepareTools?.()
  const result = await skill.executeTool({
    id: 'spaces',
    name: 'list_knowledge_spaces',
    input: { cursor: spaceId, limit: 50 },
  })
  expect(result.isError).toBeFalsy()
  expect(JSON.parse(result.output)).toEqual({
    items: [{ id: spaceId, title: '我的知识库', state: 'active' }],
    nextCursor: null,
  })
  expect(api.listSpaces).toHaveBeenCalledWith(1, { cursor: spaceId, limit: 50 })
})

it('reports a real cancelled processing operation instead of labeling every unready file as still indexing', async () => {
  const api = fixtureApi()
  api.getOperation.mockResolvedValue({
    ok: true,
    value: {
      id: operationId,
      spaceId,
      documentId,
      kind: 'upload',
      phase: 'cancelled',
      expectedGeneration: '0',
      targetVersionId: versionId,
      error: null,
    },
  })
  const skill = createKnowledgeSkill(api)
  await skill.prepareTools?.()
  const result = await skill.executeTool({
    id: 'status',
    name: 'get_knowledge_status',
    input: { spaceId, documentId, operationId },
  })
  expect(result.isError).toBeFalsy()
  expect(JSON.parse(result.output)).toMatchObject({ phase: 'cancelled', documentId })
})

it.each(['FORBIDDEN', 'knowledge:request-timeout', 'knowledge:account-changed'] as const)(
  'reports %s as a failed search, never as an empty knowledge library',
  async (code) => {
    const api = fixtureApi()
    api.search.mockResolvedValue({ ok: false, code })
    const skill = createKnowledgeSkill(api)
    await skill.prepareTools?.()
    const result = await skill.executeTool({
      id: 'failure',
      name: 'search_knowledge',
      input: { query: '中原工学院', scope: { kind: 'spaces', spaceIds: [spaceId] } },
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.output)).toEqual({ ok: false, code })
    expect(result.output).not.toContain('hits')
  },
)

it('does not read guessed citation IDs that were never returned by a search', async () => {
  const api = fixtureApi()
  const skill = createKnowledgeSkill(api)
  await skill.prepareTools?.()
  const result = await skill.executeTool({
    id: 'guess',
    name: 'read_knowledge_source',
    input: { citationId: 'K999' },
  })
  expect(result.isError).toBe(true)
  expect(api.getSourceUnit).not.toHaveBeenCalled()
})

it('discards a catalog reply that finishes after the user stopped the run', async () => {
  const api = fixtureApi()
  const controller = new AbortController()
  api.listSpaces.mockImplementation(async () => {
    controller.abort()
    return {
      ok: true,
      value: {
        items: [{ id: spaceId, title: '旧账号私密目录', state: 'active' }],
        nextCursor: null,
      },
    }
  })
  const skill = createKnowledgeSkill(api)
  await skill.prepareTools?.()
  const result = await skill.executeTool(
    { id: 'late', name: 'list_knowledge_spaces', input: {} },
    controller.signal,
  )
  expect(result.isError).toBe(true)
  expect(result.output).not.toContain('旧账号私密目录')
  expect(result.output).toContain('knowledge:cancelled')
})
