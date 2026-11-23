import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { registerKnowledgeIpc } from '../src/main/knowledge-ipc'
import { uploadNetwork } from './knowledge-upload-fixtures'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  token: vi.fn(async () => 'synthetic-token'),
  dialog: vi.fn(),
  confirmation: vi.fn(),
  controller: new AbortController(),
  sessionId: 1,
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      fixture.handlers.set(channel, handler),
  },
  dialog: { showOpenDialog: fixture.dialog, showMessageBox: fixture.confirmation },
}))
vi.mock('../src/main/auth', () => ({
  getAccountKnowledgeAccess: () => ({
    apiBase: () => 'https://account.invalid',
    knowledgeBase: () => 'https://account.invalid/api/knowledge',
    bind: () => ({
      userId: 'synthetic-A',
      sessionId: fixture.sessionId,
      signal: fixture.controller.signal,
    }),
    isCurrent: (binding: { sessionId: number }) => binding.sessionId === fixture.sessionId,
    token: fixture.token,
  }),
}))

const mainFrame = {}
const webContents = { mainFrame, isDestroyed: () => false }
const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow
const event = { sender: webContents, senderFrame: mainFrame }
const spaceId = '019a1234-0000-7000-8000-000000000001'
const documentId = '019a1234-0000-7000-8000-000000000002'
const operationId = '019a1234-0000-7000-8000-000000000003'
const versionId = '019a1234-0000-7000-8000-000000000004'
const buildId = '019a1234-0000-7000-8000-000000000005'
const sourceUnitId = '019a1234-0000-7000-8000-000000000006'
const sourceHash = 'a'.repeat(64)
const documentTarget = { spaceId, documentId }
const documentDto = {
  id: documentId,
  spaceId,
  title: '合成TXT',
  tags: [],
  purpose: 'facts',
  generation: '0',
  active: null,
  desired: null,
  deletedAt: null,
}
const sourceUnitDto = {
  id: sourceUnitId,
  spaceId,
  documentId,
  versionId,
  buildId,
  indexProfileId: spaceId,
  format: 'txt',
  sourceHash,
  parserRevision: 'txt-1',
  ordinal: 0,
  type: 'paragraph',
  text: '合成原文',
  textHash: sourceHash,
  locator: {
    schemaVersion: 1,
    format: 'txt',
    sourceHash,
    textHash: sourceHash,
    span: { unit: 'unicode_code_point', origin: 0, start: 0, end: 4 },
    headingPath: [],
    lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 1, end: 1 },
  },
  coverage: {
    schemaVersion: 1,
    format: 'txt',
    sourceHash,
    parserRevision: 'txt-1',
    scope: 'document',
    unit: 'line',
    status: 'unknown',
    expectedUnits: null,
    completedUnits: 0,
    missingUnits: null,
    excludedUnits: 0,
    warnings: [],
  },
  warnings: [],
}

beforeEach(() => {
  fixture.handlers.clear()
  fixture.token.mockClear()
  fixture.dialog.mockReset()
  fixture.confirmation.mockReset()
  fixture.controller = new AbortController()
  fixture.sessionId += 1
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        items: [{ id: spaceId, title: '合成空间', state: 'active' }],
        nextCursor: null,
      }),
    ),
  )
  registerKnowledgeIpc(() => window)
})
afterEach(() => vi.unstubAllGlobals())

it('cancels document deletion in the native dialog without sending a mutation', async () => {
  fixture.confirmation.mockResolvedValue({ response: 0 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(documentDto)),
  )
  expect(await fixture.handlers.get('knowledge:delete-document')!(event, documentTarget)).toEqual({
    ok: true,
    value: null,
  })
  expect(fixture.confirmation).toHaveBeenCalledWith(
    window,
    expect.objectContaining({
      type: 'warning',
      defaultId: 0,
      cancelId: 0,
      detail: expect.stringContaining('合成TXT'),
    }),
  )
  expect(fetch).toHaveBeenCalledOnce()
  expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET')
})

it('resumes an uncertain deletion with the same intent without re-reading a tombstoned document', async () => {
  fixture.confirmation.mockResolvedValue({ response: 1 })
  const intents: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, options: RequestInit) => {
      if (options.method === 'GET') {
        expect(intents).toHaveLength(0)
        return Response.json(documentDto)
      }
      expect(url.pathname).toBe('/api/knowledge/deletions')
      expect(options.method).toBe('DELETE')
      const body = JSON.parse(String(options.body)) as { id: string }
      expect(body).toEqual({
        id: expect.any(String),
        scope: { kind: 'document', ...documentTarget },
      })
      intents.push(body.id)
      if (intents.length === 1) throw new TypeError('synthetic lost response')
      return Response.json({ intentId: body.id, phase: 'deleted' })
    }),
  )
  const remove = fixture.handlers.get('knowledge:delete-document')!
  expect(await remove(event, documentTarget)).toEqual({
    ok: false,
    code: 'knowledge:request-failed',
  })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(await remove(event, documentTarget)).toEqual({
    ok: true,
    value: { intentId: intents[0], phase: 'deleted' },
  })
  expect(intents).toHaveLength(2)
  expect(intents[1]).toBe(intents[0])
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(fixture.confirmation).toHaveBeenCalledTimes(2)
})

it.each(['deleting', 'deleted'] as const)(
  'relays %s without inventing an indexing operation',
  async (phase) => {
    fixture.confirmation.mockResolvedValue({ response: 1 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, options: RequestInit) => {
        if (options.method === 'GET') return Response.json(documentDto)
        const body = JSON.parse(String(options.body)) as { id: string }
        return Response.json({ intentId: body.id, phase })
      }),
    )
    const remove = fixture.handlers.get('knowledge:delete-document')!
    expect(await remove(event, documentTarget)).toEqual({
      ok: true,
      value: { intentId: expect.any(String), phase },
    })
    expect(await remove(event, documentTarget)).toMatchObject({ ok: true, value: { phase } })
    expect(vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === 'GET')).toHaveLength(1)
  },
)

it.each(['account', 'window'] as const)(
  'does not delete after the original %s changed in the confirmation dialog',
  async (change) => {
    let currentWindow: BrowserWindow | null = window
    fixture.handlers.clear()
    registerKnowledgeIpc(() => currentWindow)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(documentDto)),
    )
    fixture.confirmation.mockImplementation(async () => {
      if (change === 'account') {
        fixture.controller.abort()
        fixture.controller = new AbortController()
        fixture.sessionId += 1
      } else currentWindow = null
      return { response: 1 }
    })
    expect(await fixture.handlers.get('knowledge:delete-document')!(event, documentTarget)).toEqual(
      {
        ok: false,
        code: 'knowledge:account-changed',
      },
    )
    expect(fetch).toHaveBeenCalledOnce()
  },
)

it('never reuses a previous account session deletion intent', async () => {
  fixture.confirmation.mockResolvedValue({ response: 1 })
  const intents: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: URL, options: RequestInit) => {
      if (options.method === 'GET') return Response.json(documentDto)
      const body = JSON.parse(String(options.body)) as { id: string }
      intents.push(body.id)
      return Response.json({ intentId: body.id, phase: 'deleting' })
    }),
  )
  const remove = fixture.handlers.get('knowledge:delete-document')!
  expect(await remove(event, documentTarget)).toMatchObject({ ok: true })
  fixture.controller.abort()
  fixture.controller = new AbortController()
  fixture.sessionId += 1
  expect(await remove(event, documentTarget)).toMatchObject({ ok: true })
  expect(intents).toHaveLength(2)
  expect(intents[0]).not.toBe(intents[1])
  expect(vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === 'GET')).toHaveLength(2)
})

it.each([
  { kind: 'owner' },
  { spaceId },
  { ...documentTarget, title: 'renderer supplied title' },
  { ...documentTarget, ownerId: spaceId },
])('rejects non-document deletion targets before opening a dialog %#', async (target) => {
  expect(await fixture.handlers.get('knowledge:delete-document')!(event, target)).toEqual({
    ok: false,
    code: 'INVALID_REQUEST',
  })
  expect(fetch).not.toHaveBeenCalled()
  expect(fixture.confirmation).not.toHaveBeenCalled()
})

it('does not accept an unrelated or invalid deletion receipt or retry it automatically', async () => {
  fixture.confirmation.mockResolvedValue({ response: 1 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: URL, options: RequestInit) => {
      if (options.method === 'GET') return Response.json(documentDto)
      return Response.json({ intentId: operationId, phase: 'deleted' })
    }),
  )
  expect(await fixture.handlers.get('knowledge:delete-document')!(event, documentTarget)).toEqual({
    ok: false,
    code: 'knowledge:invalid-response',
  })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('rejects other windows and child frames before touching account credentials', async () => {
  const handler = fixture.handlers.get('knowledge:list-spaces')!
  expect(await handler({ ...event, sender: {} })).toEqual({ ok: false, code: 'FORBIDDEN' })
  expect(await handler({ ...event, senderFrame: {} })).toEqual({ ok: false, code: 'FORBIDDEN' })
  expect(fixture.token).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('uses the signed-in SDK and returns only the validated DTO to the home frame', async () => {
  expect(await fixture.handlers.get('knowledge:list-spaces')!(event)).toEqual({
    ok: true,
    value: { items: [{ id: spaceId, title: '合成空间', state: 'active' }], nextCursor: null },
  })
  expect(fixture.token).toHaveBeenCalledOnce()
})

it('creates a space with a main-generated identity rather than accepting an arbitrary renderer target', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, options: RequestInit) => {
      expect(options.method).toBe('PUT')
      expect(JSON.parse(String(options.body))).toEqual({ title: '团队资料' })
      return Response.json({
        id: url.pathname.split('/').at(-1),
        title: '团队资料',
        state: 'active',
      })
    }),
  )
  expect(await fixture.handlers.get('knowledge:create-space')!(event, '团队资料')).toMatchObject({
    ok: true,
    value: { title: '团队资料', state: 'active' },
  })
})

it('searches inside the space the desktop selected and returns validated hits', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, options: RequestInit) => {
      expect(url.pathname.endsWith('/search')).toBe(true)
      expect(JSON.parse(String(options.body))).toEqual({
        scope: { kind: 'spaces', spaceIds: [spaceId] },
        query: '合成查询',
        limit: 10,
      })
      return Response.json({
        runId: '019a1234-0000-7000-8000-000000000007',
        callId: '019a1234-0000-7000-8000-000000000008',
        attemptId: '019a1234-0000-7000-8000-000000000009',
        indexProfileId: spaceId,
        hits: [],
      })
    }),
  )
  expect(
    await fixture.handlers.get('knowledge:search')!(event, { spaceId, query: '合成查询' }),
  ).toMatchObject({ ok: true, value: { hits: [] } })
})

it('rejects a search without a desktop-chosen space instead of querying every space', async () => {
  expect(await fixture.handlers.get('knowledge:search')!(event, { query: '合成查询' })).toEqual({
    ok: false,
    code: 'INVALID_REQUEST',
  })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  [
    'knowledge:get-source-unit',
    { spaceId, documentId, versionId, buildId, sourceUnitId },
    sourceUnitDto,
  ],
  ['knowledge:list-documents', spaceId, { items: [documentDto], nextCursor: null }],
  ['knowledge:get-document', documentTarget, documentDto],
  [
    'knowledge:get-operation',
    { ...documentTarget, operationId },
    {
      id: operationId,
      ...documentTarget,
      kind: 'upload',
      phase: 'uploading',
      expectedGeneration: '0',
      targetVersionId: null,
      error: null,
    },
  ],
  [
    'knowledge:get-quota',
    undefined,
    {
      ownerState: 'active',
      activeIndexProfileId: null,
      policyRevision: null,
      updatedAt: '2026-10-26T00:00:00.000Z',
      limits: null,
      active: { files: '0', bytes: '0', chunks: '0' },
      reserved: { files: '0', bytes: '0', chunks: '0' },
      physical: { accountedBytes: '0', reservedBytes: '0', limitBytes: '0' },
    },
  ],
] as const)(
  'relays %s through the existing SDK without exposing credentials',
  async (channel, input, value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(value)),
    )
    expect(await fixture.handlers.get(channel)!(event, input)).toEqual({ ok: true, value })
  },
)

async function pickedText(content: string | Uint8Array = 'test', name = '合成.txt') {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-picker-'))
  onTestFinished(async () => {
    const [target, parent] = await Promise.all([realpath(directory), realpath(tmpdir())])
    if (!target.startsWith(parent + sep)) throw new Error('TEST_PATH_INVALID')
    await rm(target, { recursive: true, force: true })
  })
  const path = join(directory, name)
  await writeFile(path, content)
  fixture.dialog.mockResolvedValue({ canceled: false, filePaths: [path] })
  return path
}

it('cancels a picker without creating a document and rejects renderer-supplied file paths', async () => {
  fixture.dialog.mockResolvedValue({ canceled: true, filePaths: [] })
  vi.stubGlobal('fetch', uploadNetwork(spaceId))
  const upload = fixture.handlers.get('knowledge:upload-text')!
  expect(await upload(event, { spaceId, path: 'D:\\private.txt' })).toEqual({
    ok: false,
    code: 'INVALID_REQUEST',
  })
  expect(fixture.dialog).not.toHaveBeenCalled()
  expect(await upload(event, spaceId)).toEqual({ ok: true, value: null })
  expect(vi.mocked(fetch).mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true)
})

it.each(['txt', 'md'] as const)(
  'hashes the chosen %s, uploads without account credentials to OSS, then completes admission',
  async (format) => {
    await pickedText('test', `合成.${format}`)
    const network = uploadNetwork(spaceId)
    vi.stubGlobal('fetch', network)
    const result = await fixture.handlers.get('knowledge:upload-text')!(event, spaceId)
    expect(result).toMatchObject({
      ok: true,
      value: {
        document: { title: `合成.${format}`, spaceId },
        operation: { phase: 'queued', targetVersionId: operationId },
      },
    })
    const completion = network.mock.calls.find(([url]) =>
      String(url).endsWith('/uploads/completion'),
    )
    expect(JSON.parse(String(completion?.[1]?.body))).toMatchObject({
      declaredBytes: '4',
      format,
      sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    })
    const transfer = network.mock.calls.find(([url]) => String(url).includes('.aliyuncs.com/'))
    expect(transfer?.[1]?.headers).toBeUndefined()
    const form = transfer?.[1]?.body
    expect(form).toBeInstanceOf(FormData)
    if (!(form instanceof FormData)) throw new Error('Expected upload form')
    const file = form.get('file')
    if (!(file instanceof Blob)) throw new Error('Expected selected TXT')
    expect(await file.text()).toBe('test')
  },
)

it.each([
  { format: 'docx', content: Uint8Array.from([0x50, 0x4b, 3, 4, 0xff, 0, 0xfe]) },
  {
    format: 'pdf',
    content: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0xfe]),
  },
] as const)(
  'uploads the exact selected $format bytes rather than decoding or converting them to text',
  async ({ format, content }) => {
    await pickedText(content, `合成.${format}`)
    const network = uploadNetwork(spaceId)
    vi.stubGlobal('fetch', network)
    expect(await fixture.handlers.get('knowledge:upload-text')!(event, spaceId)).toMatchObject({
      ok: true,
      value: { operation: { phase: 'queued' } },
    })
    const completion = network.mock.calls.find(([url]) =>
      String(url).endsWith('/uploads/completion'),
    )
    expect(JSON.parse(String(completion?.[1]?.body))).toMatchObject({
      format,
      declaredBytes: String(content.length),
      sourceHash: createHash('sha256').update(content).digest('hex'),
    })
    const upload = network.mock.calls.find(([url]) => String(url).includes('.aliyuncs.com/'))?.[1]
      ?.body
    if (!(upload instanceof FormData)) throw new Error('Expected upload form')
    const file = upload.get('file')
    if (!(file instanceof Blob)) throw new Error('Expected binary document')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(content)
  },
)

it('does not claim upload success when staging succeeded but completion was refused', async () => {
  await pickedText()
  vi.stubGlobal('fetch', uploadNetwork(spaceId, true))
  expect(await fixture.handlers.get('knowledge:upload-text')!(event, spaceId)).toEqual({
    ok: false,
    code: 'FORBIDDEN',
  })
})

it('does not read or upload a file picked after the account changed', async () => {
  const path = await pickedText()
  fixture.dialog.mockImplementation(async () => {
    fixture.controller.abort()
    fixture.controller = new AbortController()
    fixture.sessionId += 1
    return { canceled: false, filePaths: [path] }
  })
  const network = uploadNetwork(spaceId)
  vi.stubGlobal('fetch', network)
  expect(await fixture.handlers.get('knowledge:upload-text')!(event, spaceId)).toEqual({
    ok: false,
    code: 'knowledge:account-changed',
  })
  expect(network.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true)
})

it.each([
  ['   \r\n', '空白.txt', 'EMPTY_CONTENT'],
  [Uint8Array.from([0xff, 0xfe, 0xfa]), '错误编码.txt', 'UNSUPPORTED_FORMAT'],
  ['test', '错误格式.pdf', 'UNSUPPORTED_FORMAT'],
  ['test', '错误格式.docx', 'UNSUPPORTED_FORMAT'],
  ['test', '待接选择流程.xlsx', 'UNSUPPORTED_FORMAT'],
] as const)(
  'rejects invalid chosen content before any remote mutation %#',
  async (content, name, code) => {
    await pickedText(content, name)
    const network = uploadNetwork(spaceId)
    vi.stubGlobal('fetch', network)
    expect(await fixture.handlers.get('knowledge:upload-text')!(event, spaceId)).toEqual({
      ok: false,
      code,
    })
    expect(network.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true)
  },
)

it('rejects a file over the desktop bound before reading or allocating its full size', async () => {
  const path = await pickedText()
  await truncate(path, 8 * 1024 * 1024 + 1)
  const network = uploadNetwork(spaceId)
  vi.stubGlobal('fetch', network)
  expect(await fixture.handlers.get('knowledge:upload-text')!(event, spaceId)).toEqual({
    ok: false,
    code: 'INVALID_REQUEST',
  })
  expect(network.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true)
})

it('returns only the stable service error code rather than diagnostics or URLs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ code: 'FORBIDDEN', requestId: null }, { status: 403 })),
  )
  expect(await fixture.handlers.get('knowledge:list-spaces')!(event)).toEqual({
    ok: false,
    code: 'FORBIDDEN',
  })
})
