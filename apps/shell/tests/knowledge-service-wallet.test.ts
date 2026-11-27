import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import {
  KnowledgeServiceWallet,
  readKnowledgeServicePlan,
} from '../src/renderer/src/KnowledgeServiceWallet'
const grant = {
  storageBytes: '134217728',
  startsAt: '2026-11-26T00:00:00Z',
  permanent: true,
  active: true,
}
it('shows permanent storage without a customer token allowance', () => {
  const input = { managed: true, storageBytes: '134217728', grants: [grant] }
  const html = renderToStaticMarkup(
    createElement(KnowledgeServiceWallet, {
      input,
      language: 'zh-CN',
      onRecharge: () => {},
      failed: false,
    }),
  )
  expect(html).toContain('128 MB')
  expect(html).toContain('永久有效')
  expect(html).toContain('AI 问答另使用 Office AI 余额')
  expect(html).not.toMatch(/tokens|处理额度|剩余可用|钱包尚未开户/)
  expect(readKnowledgeServicePlan({ ...input, storageBytes: '1' })).toBeNull()
  expect(readKnowledgeServicePlan({ ...input, storageBytes: '-1' })).toBeNull()
  expect(
    readKnowledgeServicePlan({ ...input, grants: [{ ...grant, permanent: false }] }),
  ).toBeNull()
})
it('shows inactive storage rights without hiding existing source access', () => {
  const html = renderToStaticMarkup(
    createElement(KnowledgeServiceWallet, {
      input: { managed: true, storageBytes: '0', grants: [{ ...grant, active: false }] },
      language: 'zh-CN',
      onRecharge: () => {},
      failed: false,
    }),
  )
  expect(html).toContain('永久空间权益尚未生效')
  expect(html).toContain('原文仍可查看')
  expect(html).not.toContain('tokens')
})
