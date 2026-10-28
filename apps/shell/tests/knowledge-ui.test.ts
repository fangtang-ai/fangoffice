/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountUsage, AccountView } from '../src/shared/home-api'
import type { KnowledgeApi, KnowledgeSpaces } from '../src/shared/knowledge-api'
import { KnowledgePanel } from '../src/renderer/src/KnowledgePanel'

let host: HTMLDivElement
let root: Root
const login = vi.fn()
const refreshAccount = vi.fn()
const funds = {
  product: 'knowledge_base',
  available: true,
  unavailableReason: null,
  walletStatus: 'opened',
  balanceCny: '12.00',
  reservedCny: '0.50',
  availableCny: '11.50',
  queryReserveCny: '0.01',
}
const spaceId = '019a1234-0000-7000-8000-000000000001'
const space = { id: spaceId, title: '团队资料', state: 'active' as const }
const quota = {
  ownerState: 'active' as const,
  activeIndexProfileId: spaceId,
  policyRevision: 'synthetic-test-only',
  updatedAt: '2026-10-26T00:00:00.000Z',
  limits: { files: '10', bytes: '10485760', chunks: '1000' },
  active: { files: '0', bytes: '0', chunks: '0' },
  reserved: { files: '0', bytes: '0', chunks: '0' },
  physical: { accountedBytes: '0', reservedBytes: '0', limitBytes: '10485760' },
}
const api = {
  listSpaces: vi.fn<KnowledgeApi['listSpaces']>(),
  createSpace: vi.fn<KnowledgeApi['createSpace']>(),
  listDocuments: vi.fn<KnowledgeApi['listDocuments']>(),
  getDocument: vi.fn<KnowledgeApi['getDocument']>(),
  deleteDocument: vi.fn<KnowledgeApi['deleteDocument']>(),
  getOperation: vi.fn<KnowledgeApi['getOperation']>(),
  getQuota: vi.fn<KnowledgeApi['getQuota']>(),
  search: vi.fn<KnowledgeApi['search']>(),
  getSourceUnit: vi.fn<KnowledgeApi['getSourceUnit']>(),
  uploadText: vi.fn<KnowledgeApi['uploadText']>(),
} satisfies KnowledgeApi

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  api.listSpaces.mockResolvedValue({ ok: true, value: { items: [space], nextCursor: null } })
  api.listDocuments.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } })
  api.getQuota.mockResolvedValue({ ok: false, code: 'NOT_CONFIGURED' })
  Object.defineProperty(window, 'aiOffice', { configurable: true, value: { knowledge: api } })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function render(session: AccountView, usage: AccountUsage | null = null) {
  await act(async () =>
    root.render(
      createElement(KnowledgePanel, {
        session,
        onLogin: login,
        usage,
        onRefreshAccount: refreshAccount,
      }),
    ),
  )
}

it('shows the separate knowledge balance, held funds and available funds without borrowing AI or MCP balances', async () => {
  await render(
    { loggedIn: true, userId: 'A' },
    {
      products: { office_ai: { balanceCny: '88.00' }, policy_mcp: { balanceCny: '66.00' } },
      knowledge: {
        product: 'knowledge_base',
        available: true,
        unavailableReason: null,
        walletStatus: 'opened',
        balanceCny: '12.00',
        reservedCny: '0.50',
        availableCny: '11.50',
        queryReserveCny: '0.01',
      },
    },
  )
  const wallet = host.querySelector('[data-knowledge-wallet]')
  expect(wallet?.textContent).toContain('知识资金')
  expect(wallet?.textContent).toContain('¥12.00')
  expect(wallet?.textContent).toContain('¥0.50')
  expect(wallet?.textContent).toContain('¥11.50')
  expect(wallet?.textContent).toContain('¥0.01')
  expect(wallet?.textContent).not.toContain('¥88.00')
  expect(wallet?.textContent).not.toContain('¥66.00')
})

it('keeps unknown knowledge funds distinct from zero despite funded AI/MCP wallets', async () => {
  await render(
    { loggedIn: true, userId: 'A' },
    {
      products: { office_ai: { balanceCny: '88.00' }, policy_mcp: { balanceCny: '66.00' } },
    },
  )
  const wallet = host.querySelector('[data-knowledge-wallet]')
  expect(wallet?.textContent).toContain('暂未获取知识资金状态')
  expect(wallet?.textContent).not.toContain('¥0.00')
  expect(wallet?.textContent).not.toContain('¥88.00')
})

it('shows unconfigured knowledge as disabled rather than an authorized zero balance', async () => {
  await render(
    { loggedIn: true, userId: 'A' },
    {
      knowledge: {
        ...funds,
        available: false,
        unavailableReason: 'not_configured',
        queryReserveCny: null,
      },
    },
  )
  const wallet = host.querySelector('[data-knowledge-wallet]')
  expect(wallet?.textContent).toContain('知识预算尚未开通或配置不完整')
  expect(wallet?.textContent).not.toContain('知识预算已配置')
  expect(wallet?.textContent).not.toContain('单次查询预留上限')
  expect(wallet?.textContent).not.toContain('余额不足')
})

it('uses available funds rather than total funds for the query hold warning', async () => {
  await render(
    { loggedIn: true, userId: 'A' },
    {
      knowledge: {
        ...funds,
        balanceCny: '12.00',
        reservedCny: '12.00',
        availableCny: '0.00',
      },
    },
  )
  expect(host.querySelector('[data-knowledge-wallet]')?.textContent).toContain(
    '知识可用余额不足以预留一次查询',
  )
  await render(
    { loggedIn: true, userId: 'A' },
    {
      knowledge: {
        ...funds,
        balanceCny: '0.01',
        reservedCny: '0.00',
        availableCny: '0.01',
      },
    },
  )
  expect(host.querySelector('[data-knowledge-wallet]')?.textContent).not.toContain('余额不足')
})

it('shows an unopened wallet without creating a recharge path for another product', async () => {
  await render(
    { loggedIn: true, userId: 'A' },
    {
      knowledge: {
        ...funds,
        walletStatus: 'not_opened',
        balanceCny: '0.00',
        reservedCny: '0.00',
        availableCny: '0.00',
      },
    },
  )
  expect(host.textContent).toContain('知识钱包尚未开户')
  expect(host.querySelector('[data-knowledge-wallet] button')).toBeNull()
})

it.each([
  { ...funds, product: 'office_ai' },
  { ...funds, availableCny: '-1.00' },
  { ...funds, balanceCny: 'NaN' },
  { ...funds, queryReserveCny: '0.00' },
  { ...funds, availableCny: 12 },
  { ...funds, available: 'true' },
  { ...funds, walletStatus: { toString: null, valueOf: null } },
  { ...funds, available: false, unavailableReason: { toString: null, valueOf: null } },
])('fails closed on malformed knowledge wallet data: %j', async (knowledge) => {
  await render({ loggedIn: true, userId: 'A' }, { knowledge })
  const wallet = host.querySelector('[data-knowledge-wallet]')
  expect(wallet?.textContent).toContain('暂未获取知识资金状态')
  expect(wallet?.querySelector('dl')).toBeNull()
})

it('refreshes the existing account usage together with the knowledge view', async () => {
  await render({ loggedIn: true, userId: 'A' }, { knowledge: funds })
  await act(async () => host.querySelector<HTMLButtonElement>('header button')!.click())
  expect(refreshAccount).toHaveBeenCalledOnce()
  expect(api.listSpaces).toHaveBeenCalledTimes(2)
})

it('offers sign-in without querying a private knowledge base while signed out', async () => {
  await render({ loggedIn: false })
  expect(host.textContent).toContain('登录后查看云端知识库')
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(login).toHaveBeenCalledOnce()
  expect(api.listSpaces).not.toHaveBeenCalled()
})

it('lists real spaces but reports missing quota honestly instead of enabling upload', async () => {
  await render({ loggedIn: true, userId: 'A' })
  expect(host.textContent).toContain('团队资料')
  expect(host.textContent).toContain('知识库权益或服务尚未配置')
  expect(host.querySelector<HTMLButtonElement>('[data-action="upload"]')?.disabled).toBe(true)
})

it('explains an existing owner whose indexing profile and policy have not been configured', async () => {
  api.getQuota.mockResolvedValue({
    ok: true,
    value: { ...quota, activeIndexProfileId: null, policyRevision: null, limits: null },
  })
  await render({ loggedIn: true, userId: 'A' })
  expect(host.textContent).toContain('知识库权益或服务尚未配置')
  expect(host.querySelector<HTMLButtonElement>('[data-action="upload"]')?.disabled).toBe(true)
})

it('drops a late previous-account response after the session changes', async () => {
  let finish!: (value: { ok: true; value: KnowledgeSpaces }) => void
  api.listSpaces.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  await render({ loggedIn: true, userId: 'A' })
  await render({ loggedIn: true, userId: 'B' })
  await act(async () =>
    finish({ ok: true, value: { items: [{ ...space, title: 'A的私密资料' }], nextCursor: null } }),
  )
  expect(host.textContent).toContain('团队资料')
  expect(host.textContent).not.toContain('A的私密资料')
})

it('shows queued admission rather than claiming that a selected TXT is already searchable', async () => {
  api.getQuota.mockResolvedValue({ ok: true, value: quota })
  const documentId = '019a1234-0000-7000-8000-000000000002'
  const operationId = '019a1234-0000-7000-8000-000000000003'
  api.uploadText.mockResolvedValue({
    ok: true,
    value: {
      document: {
        id: documentId,
        spaceId,
        title: '入库中.txt',
        tags: [],
        purpose: 'facts',
        generation: '0',
        active: null,
        desired: null,
        deletedAt: null,
      },
      operation: {
        id: operationId,
        spaceId,
        documentId,
        kind: 'upload',
        phase: 'queued',
        expectedGeneration: '0',
        targetVersionId: documentId,
        error: null,
      },
    },
  })
  await render({ loggedIn: true, userId: 'A' })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-action="upload"]')!.click())
  expect(api.uploadText).toHaveBeenCalledExactlyOnceWith(spaceId)
  expect(host.querySelector('[data-operation]')?.textContent).toContain('等待处理')
  expect(host.querySelector('[data-operation]')?.textContent).not.toContain('已入库')
})

it('creates a named space and selects the server-confirmed result', async () => {
  api.getQuota.mockResolvedValue({ ok: true, value: quota })
  const created = { ...space, id: '019a1234-0000-7000-8000-000000000007', title: '新空间' }
  api.createSpace.mockResolvedValue({ ok: true, value: created })
  await render({ loggedIn: true, userId: 'A' })
  const input = host.querySelector<HTMLInputElement>('[name="space-title"]')
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '新空间')
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(api.createSpace).toHaveBeenCalledExactlyOnceWith('新空间')
  expect(host.querySelector('select')?.value).toBe(created.id)
})

it('refreshes the selected document operation and shows ready only on a real ready response', async () => {
  const documentId = '019a1234-0000-7000-8000-000000000002'
  const operationId = '019a1234-0000-7000-8000-000000000003'
  const target = { spaceId, documentId, operationId }
  api.listDocuments.mockResolvedValue({
    ok: true,
    value: {
      items: [
        {
          id: documentId,
          spaceId,
          title: '入库中.txt',
          tags: [],
          purpose: 'facts',
          generation: '0',
          active: null,
          desired: { operationId, versionId: documentId },
          deletedAt: null,
        },
      ],
      nextCursor: null,
    },
  })
  api.getOperation.mockResolvedValue({
    ok: true,
    value: {
      ...target,
      id: operationId,
      kind: 'upload',
      phase: 'ready',
      expectedGeneration: '0',
      targetVersionId: documentId,
      error: null,
    },
  })
  await render({ loggedIn: true, userId: 'A' })
  const button = host.querySelector<HTMLButtonElement>('[data-action="inspect"]')
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  expect(api.getOperation).toHaveBeenCalledExactlyOnceWith(target)
  expect(host.querySelector('[data-operation]')?.textContent).toContain('已入库')
})

it('loads the next document page instead of silently hiding files after the first page', async () => {
  const firstId = '019a1234-0000-7000-8000-000000000002'
  const first = {
    id: firstId,
    spaceId,
    title: '第一页.txt',
    tags: [],
    purpose: 'facts' as const,
    generation: '0',
    active: null,
    desired: null,
    deletedAt: null,
  }
  api.listDocuments.mockResolvedValueOnce({
    ok: true,
    value: { items: [first], nextCursor: firstId },
  })
  api.listDocuments.mockResolvedValueOnce({
    ok: true,
    value: {
      items: [{ ...first, id: '019a1234-0000-7000-8000-000000000003', title: '第二页.txt' }],
      nextCursor: null,
    },
  })
  await render({ loggedIn: true, userId: 'A' })
  const next = host.querySelector<HTMLButtonElement>('[data-action="more-documents"]')
  expect(next).not.toBeNull()
  await act(async () => next!.click())
  expect(api.listDocuments).toHaveBeenLastCalledWith(spaceId, { cursor: firstId })
  expect(host.textContent).toContain('第一页.txt')
  expect(host.textContent).toContain('第二页.txt')
})

it('loads more spaces without losing the selected space', async () => {
  api.listSpaces.mockResolvedValueOnce({ ok: true, value: { items: [space], nextCursor: spaceId } })
  api.listSpaces.mockResolvedValueOnce({
    ok: true,
    value: {
      items: [{ ...space, id: '019a1234-0000-7000-8000-000000000003', title: '更多资料空间' }],
      nextCursor: null,
    },
  })
  await render({ loggedIn: true, userId: 'A' })
  const next = host.querySelector<HTMLButtonElement>('[data-action="more-spaces"]')
  expect(next).not.toBeNull()
  await act(async () => next!.click())
  expect(api.listSpaces).toHaveBeenLastCalledWith({ cursor: spaceId })
  expect(host.querySelector('select')?.value).toBe(spaceId)
  expect(host.textContent).toContain('更多资料空间')
})

it('keeps writes disabled while a refresh is still checking the current policy and spaces', async () => {
  api.getQuota.mockResolvedValue({ ok: true, value: quota })
  await render({ loggedIn: true, userId: 'A' })
  let finish!: (value: { ok: true; value: KnowledgeSpaces }) => void
  api.listSpaces.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const refresh = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === '刷新',
  )!
  await act(async () => refresh.click())
  expect(host.querySelector<HTMLInputElement>('[name="space-title"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true)
  await act(async () => finish({ ok: true, value: { items: [space], nextCursor: null } }))
})

it.each([false, true])(
  'searches the selected space and opens the chosen source (multiple: %s)',
  async (multipleSources) => {
    api.getQuota.mockResolvedValue({ ok: true, value: quota })
    const documentId = '019a1234-0000-7000-8000-000000000002'
    const versionId = '019a1234-0000-7000-8000-000000000004'
    const buildId = '019a1234-0000-7000-8000-000000000005'
    const chunkId = '019a1234-0000-7000-8000-000000000006'
    const sourceUnitId = '019a1234-0000-7000-8000-000000000007'
    const secondSourceUnitId = '019a1234-0000-7000-8000-00000000000c'
    const selectedSourceUnitId = multipleSources ? secondSourceUnitId : sourceUnitId
    const hash = 'a'.repeat(64)
    api.search.mockResolvedValue({
      ok: true,
      value: {
        runId: '019a1234-0000-7000-8000-000000000008',
        callId: '019a1234-0000-7000-8000-000000000009',
        attemptId: '019a1234-0000-7000-8000-00000000000a',
        indexProfileId: spaceId,
        hits: [
          {
            spaceId,
            documentId,
            versionId,
            buildId,
            chunkId,
            title: '团队资料.txt',
            chunkTextHash: hash,
            distance: 0.25,
            snippet: { text: '命中四字', startCp: 0, endCp: 4, chunkCodePointLength: 4 },
            sources: multipleSources
              ? [
                  { sourceUnitId, startCp: 0, endCp: 2 },
                  { sourceUnitId: secondSourceUnitId, startCp: 2, endCp: 4 },
                ]
              : [{ sourceUnitId, startCp: 0, endCp: 4 }],
          },
        ],
      },
    })
    api.listDocuments.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [
          {
            id: documentId,
            spaceId,
            title: '团队资料.txt',
            tags: [],
            purpose: 'facts',
            generation: '0',
            active: null,
            desired: null,
            deletedAt: null,
          },
        ],
        nextCursor: null,
      },
    })
    api.getSourceUnit.mockResolvedValue({
      ok: true,
      value: {
        id: selectedSourceUnitId,
        spaceId,
        documentId,
        versionId,
        buildId,
        indexProfileId: spaceId,
        format: 'txt',
        sourceHash: hash,
        parserRevision: 'txt-1',
        ordinal: 0,
        type: 'paragraph',
        text: '来源原文',
        textHash: hash,
        locator: {
          schemaVersion: 1,
          format: 'txt',
          sourceHash: hash,
          textHash: hash,
          span: { unit: 'unicode_code_point', origin: 0, start: 0, end: 4 },
          headingPath: [],
          lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 1, end: 1 },
        },
        coverage: {
          schemaVersion: 1,
          format: 'txt',
          sourceHash: hash,
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
      },
    })
    await render({ loggedIn: true, userId: 'A' })
    const input = host.querySelector<HTMLInputElement>('[name="search-query"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '命中')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(api.search).toHaveBeenCalledExactlyOnceWith({ spaceId, query: '命中' })
    expect(host.textContent).toContain('命中四字')
    if (multipleSources) {
      const select = host.querySelector<HTMLSelectElement>('[data-source-select]')
      expect(select).not.toBeNull()
      expect(select?.options).toHaveLength(2)
      await act(async () => {
        select!.value = secondSourceUnitId
        select!.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(api.getSourceUnit).not.toHaveBeenCalled()
    }
    await act(async () => host.querySelector<HTMLButtonElement>('[data-action="source"]')!.click())
    expect(api.getSourceUnit).toHaveBeenCalledExactlyOnceWith({
      spaceId,
      documentId,
      versionId,
      buildId,
      sourceUnitId: selectedSourceUnitId,
    })
    expect(host.querySelector('[data-source]')?.textContent).toContain('来源原文')
    api.deleteDocument.mockResolvedValue({
      ok: true,
      value: {
        intentId: '019a1234-0000-7000-8000-00000000000b',
        phase: 'deleted',
      },
    })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-action="delete-document"]')!.click(),
    )
    expect(host.querySelector('[data-source]')).toBeNull()
    expect(host.querySelector('[data-action="source"]')).toBeNull()
    expect(host.textContent).not.toContain('命中四字')
  },
)
