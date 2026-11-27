/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KnowledgeExpansionPacks } from '../src/renderer/src/KnowledgeExpansionPacks'
import type { HomeApi } from '../src/shared/home-api'

let host: HTMLDivElement
let root: Root
const catalog = vi.fn<HomeApi['getKnowledgeExpansionPacks']>()
const openRecharge = vi.fn<HomeApi['openRecharge']>()
const packs = [
  { id: 'light', name: '轻量扩容包', priceFen: 990, storageMiB: 128 },
  { id: 'standard', name: '标准扩容包', priceFen: 2990, storageMiB: 512 },
  { id: 'pro', name: '专业扩容包', priceFen: 4990, storageMiB: 1024 },
]
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  catalog.mockReset().mockResolvedValue(packs)
  openRecharge.mockReset().mockResolvedValue()
  Object.defineProperty(window, 'aiOffice', {
    configurable: true,
    value: { getKnowledgeExpansionPacks: catalog, openRecharge },
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function mount() {
  await act(async () => root.render(createElement(KnowledgeExpansionPacks, { language: 'zh-CN' })))
}
function button(label: string) {
  const value = [...host.querySelectorAll('button')].find((item) => item.textContent === label)
  if (!value) throw new Error(`Missing button: ${label}`)
  return value
}
it('shows all live packs with permanent/additive storage and routes to the knowledge purchase page', async () => {
  await mount()
  expect(host.querySelectorAll('li')).toHaveLength(3)
  expect(host.textContent).toContain('128 MB')
  expect(host.textContent).toContain('512 MB')
  expect(host.textContent).toContain('1 GB')
  expect(host.textContent).toContain('永久增加空间')
  expect(host.textContent).toContain('AI 问答另使用 Office AI 余额')
  expect(host.textContent).not.toMatch(/tokens|token 额度|每月|自然月/)
  expect(openRecharge).not.toHaveBeenCalled()
  await act(async () => button('前往网站选择扩容包').click())
  expect(openRecharge).toHaveBeenCalledWith('knowledge_base')
})
it('refreshes server prices and hides removed packs', async () => {
  await mount()
  catalog.mockResolvedValueOnce([{ ...packs[0]!, priceFen: 1290 }])
  await act(async () => button('刷新套餐').click())
  expect(host.querySelectorAll('li')).toHaveLength(1)
  expect(host.textContent).toContain('12.90')
  expect(host.textContent).not.toContain('标准扩容包')
})
it('shows no invented offers on catalog failure or empty results, and supports retry', async () => {
  catalog.mockRejectedValueOnce(new Error('private-error'))
  await mount()
  expect(host.textContent).toContain('套餐暂时无法读取')
  expect(host.textContent).not.toContain('private-error')
  expect(host.querySelectorAll('li')).toHaveLength(0)
  catalog.mockResolvedValueOnce([])
  await act(async () => button('刷新套餐').click())
  expect(host.textContent).toContain('当前暂无上架扩容包')
})
it('reports a failed recharge handoff without leaking internal details', async () => {
  await mount()
  openRecharge.mockRejectedValueOnce(new Error('private-error'))
  await act(async () => button('前往网站选择扩容包').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法打开知识库套餐页面')
  expect(host.textContent).not.toContain('private-error')
})
