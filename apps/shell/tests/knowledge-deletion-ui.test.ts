/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { KnowledgeApi, KnowledgeDocument } from '../src/shared/knowledge-api'
import { KnowledgePanel } from '../src/renderer/src/KnowledgePanel'

let host: HTMLDivElement
let root: Root
const spaceId = '019a1234-0000-7000-8000-000000000001'
const documentId = '019a1234-0000-7000-8000-000000000002'
const intentId = '019a1234-0000-7000-8000-000000000003'
const documentDto = {
  id: documentId,
  spaceId,
  title: '待删资料.txt',
  tags: [],
  purpose: 'facts',
  generation: '0',
  active: null,
  desired: null,
  deletedAt: null,
} satisfies KnowledgeDocument
const quota = {
  ownerState: 'active' as const,
  activeIndexProfileId: spaceId,
  policyRevision: 'synthetic-test-only',
  updatedAt: '2026-10-27T00:00:00.000Z',
  limits: { files: '10', bytes: '10485760', chunks: '1000' },
  active: { files: '1', bytes: '4', chunks: '1' },
  reserved: { files: '0', bytes: '0', chunks: '0' },
  physical: { accountedBytes: '4', reservedBytes: '0', limitBytes: '10485760' },
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
  api.listSpaces.mockResolvedValue({
    ok: true,
    value: { items: [{ id: spaceId, title: '测试空间', state: 'active' }], nextCursor: null },
  })
  api.listDocuments.mockResolvedValue({
    ok: true,
    value: { items: [documentDto], nextCursor: null },
  })
  api.getQuota.mockResolvedValue({ ok: true, value: quota })
  Object.defineProperty(window, 'aiOffice', { configurable: true, value: { knowledge: api } })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function render(userId = 'A') {
  await act(async () =>
    root.render(
      createElement(KnowledgePanel, {
        session: { loggedIn: true, userId },
        usage: null,
        onLogin: vi.fn(),
        onRefreshAccount: vi.fn(),
      }),
    ),
  )
}
async function remove() {
  const button = host.querySelector<HTMLButtonElement>('[data-action="delete-document"]')
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

it('shows confirmed logical deletion and refreshes documents and actual quota without promising a refund', async () => {
  await render()
  api.deleteDocument.mockResolvedValue({ ok: true, value: { intentId, phase: 'deleted' } })
  api.listDocuments.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } })
  api.getQuota.mockResolvedValue({
    ok: true,
    value: {
      ...quota,
      active: { files: '0', bytes: '0', chunks: '0' },
    },
  })
  await remove()
  expect(api.deleteDocument).toHaveBeenCalledExactlyOnceWith({ spaceId, documentId })
  expect(host.querySelector('[data-deletion]')?.textContent).toContain('已删除')
  expect(host.querySelector('[data-deletion]')?.textContent).toContain(
    '不代表物理文件已清除或费用已退款',
  )
  expect(host.querySelector('[data-action="delete-document"]')).toBeNull()
  expect(api.listDocuments).toHaveBeenCalledTimes(2)
  expect(api.getQuota).toHaveBeenCalledTimes(2)
  expect(host.textContent).toContain('资料: 0 / 10')
})

it('leaves the document and quota unchanged when native confirmation is cancelled', async () => {
  api.deleteDocument.mockResolvedValue({ ok: true, value: null })
  await render()
  await remove()
  expect(host.querySelector('[data-deletion]')).toBeNull()
  expect(host.textContent).toContain('待删资料.txt')
  expect(api.listDocuments).toHaveBeenCalledOnce()
  expect(api.getQuota).toHaveBeenCalledOnce()
})

it('keeps a pending receipt distinct from success and can confirm it after the document disappears', async () => {
  api.deleteDocument
    .mockResolvedValueOnce({ ok: true, value: { intentId, phase: 'deleting' } })
    .mockResolvedValueOnce({ ok: true, value: { intentId, phase: 'deleted' } })
  await render()
  api.listDocuments.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } })
  await remove()
  expect(host.querySelector('[data-deletion]')?.textContent).toContain('正在删除，尚未确认完成')
  expect(host.querySelector('[data-deletion]')?.textContent).not.toContain('已删除（')
  expect(host.querySelector('[data-action="delete-document"]')).toBeNull()
  expect(api.deleteDocument).toHaveBeenCalledOnce()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-action="confirm-deletion"]')!.click(),
  )
  expect(api.deleteDocument).toHaveBeenNthCalledWith(2, { spaceId, documentId })
  expect(host.querySelector('[data-deletion]')?.textContent).toContain('已删除（')
})

it('reports an uncertain request honestly and retries only after an explicit user action', async () => {
  api.deleteDocument
    .mockResolvedValueOnce({ ok: false, code: 'knowledge:request-timeout' })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: { intentId, phase: 'deleted' } })
  await render()
  api.listDocuments.mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } })
  await remove()
  expect(host.querySelector('[data-deletion]')?.textContent).toContain('删除结果未确认，可能已受理')
  expect(host.querySelector('[data-deletion]')?.textContent).not.toContain('已删除（')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('knowledge:request-timeout')
  expect(api.deleteDocument).toHaveBeenCalledOnce()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-action="confirm-deletion"]')!.click(),
  )
  expect(host.querySelector('[data-deletion]')?.textContent).toContain('删除结果未确认')
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-action="confirm-deletion"]')!.click(),
  )
  expect(api.deleteDocument.mock.calls).toEqual([
    [{ spaceId, documentId }],
    [{ spaceId, documentId }],
    [{ spaceId, documentId }],
  ])
  expect(host.querySelector('[data-deletion]')?.textContent).toContain('已删除（')
})

it.each(['frozen', 'not-configured'] as const)(
  'allows cleanup while %s instead of requiring an upload budget',
  async (state) => {
    if (state === 'frozen')
      api.getQuota.mockResolvedValue({ ok: true, value: { ...quota, ownerState: 'frozen' } })
    else api.getQuota.mockResolvedValue({ ok: false, code: 'NOT_CONFIGURED' })
    api.deleteDocument.mockResolvedValue({ ok: true, value: { intentId, phase: 'deleted' } })
    await render()
    expect(host.querySelector<HTMLButtonElement>('[data-action="upload"]')?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-action="delete-document"]')?.disabled).toBe(
      false,
    )
    await remove()
    expect(api.deleteDocument).toHaveBeenCalledOnce()
  },
)

it('does not erase another account documents or show a late previous-account deletion result', async () => {
  let finish!: (result: Awaited<ReturnType<KnowledgeApi['deleteDocument']>>) => void
  api.deleteDocument.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  await render('A')
  await remove()
  api.listDocuments.mockResolvedValue({
    ok: true,
    value: {
      items: [{ ...documentDto, title: 'B的资料.txt' }],
      nextCursor: null,
    },
  })
  await render('B')
  const readsBeforeLateReceipt = api.listDocuments.mock.calls.length
  await act(async () => finish({ ok: true, value: { intentId, phase: 'deleted' } }))
  expect(host.querySelector('[data-deletion]')).toBeNull()
  expect(host.textContent).toContain('B的资料.txt')
  expect(host.textContent).not.toContain('待删资料.txt')
  expect(api.getQuota).toHaveBeenCalledTimes(2)
  expect(api.listDocuments).toHaveBeenCalledTimes(readsBeforeLateReceipt)
})

it('retains the unresolved target and blocks a different deletion until the first is confirmed', async () => {
  const second = { ...documentDto, id: intentId, title: '另一份资料.txt' }
  api.listDocuments.mockResolvedValue({
    ok: true,
    value: { items: [documentDto, second], nextCursor: null },
  })
  api.deleteDocument.mockResolvedValue({ ok: true, value: { intentId, phase: 'deleting' } })
  await render()
  await remove()
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-action="delete-document"]')
  expect(buttons[0].disabled).toBe(false)
  expect(buttons[1].disabled).toBe(true)
  expect(host.querySelector('[data-deletion]')?.textContent).toContain('待删资料.txt')
})
