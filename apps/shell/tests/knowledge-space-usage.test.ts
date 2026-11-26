import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { KnowledgeQuota } from '../src/shared/knowledge-api'
import {
  KnowledgeSpaceUsage,
  formatKnowledgeSpaceBytes,
  knowledgeSpaceUsage,
} from '../src/renderer/src/KnowledgeSpaceUsage'

const quota: KnowledgeQuota = {
  ownerState: 'active',
  activeIndexProfileId: null,
  policyRevision: null,
  updatedAt: '2026-11-26T00:00:00Z',
  limits: { files: '1000000', bytes: '134217728', chunks: '1000' },
  active: { files: '12', bytes: '33554432', chunks: '100' },
  reserved: { files: '1', bytes: '16777216', chunks: '10' },
  physical: { accountedBytes: '33554432', reservedBytes: '16777216', limitBytes: '134217728' },
}
it('includes indexing holds in occupied storage while showing used, available and human-readable capacity', () => {
  const usage = knowledgeSpaceUsage(quota)!
  expect(usage.occupiedPercent).toBe(37.5)
  expect(usage.usedPercent).toBe(25)
  expect(usage.reservedPercent).toBe(12.5)
  expect(usage.remaining).toBe(83886080n)
  const html = renderToStaticMarkup(
    createElement(KnowledgeSpaceUsage, { quota, language: 'zh-CN' }),
  )
  for (const text of ['32 MB', '16 MB', '80 MB', '128 MB', '当前资料 12 份', '入库中预占'])
    expect(html).toContain(text)
  expect(html).toContain('role="progressbar"')
  expect(html).toContain('aria-valuenow="37.5"')
  expect(html).not.toContain('1000000')
})
it('renders empty or zero capacity without NaN or negative remaining storage', () => {
  const empty = {
    ...quota,
    limits: { ...quota.limits!, bytes: '0' },
    active: { ...quota.active, bytes: '0' },
    reserved: { ...quota.reserved, bytes: '0' },
  }
  expect(knowledgeSpaceUsage(empty)).toMatchObject({
    occupiedPercent: 0,
    remaining: 0n,
    overLimit: false,
  })
  const html = renderToStaticMarkup(
    createElement(KnowledgeSpaceUsage, { quota: empty, language: 'en' }),
  )
  expect(html).toContain('0 B')
  expect(html).not.toMatch(/NaN|Infinity/)
  expect(knowledgeSpaceUsage({ ...empty, limits: null })).toBeNull()
})
it('clamps over-capacity bars and reports the shortage without changing actual usage', () => {
  const over = { ...quota, limits: { ...quota.limits!, bytes: '16777216' } }
  const usage = knowledgeSpaceUsage(over)!
  expect(usage).toMatchObject({
    occupiedPercent: 100,
    usedPercent: 100,
    reservedPercent: 0,
    remaining: 0n,
    used: 33554432n,
    overLimit: true,
  })
  expect(
    renderToStaticMarkup(createElement(KnowledgeSpaceUsage, { quota: over, language: 'zh' })),
  ).toContain('超过当前配额')
})
it('handles large byte counters and formats binary MB/GB without exposing raw byte values', () => {
  expect(formatKnowledgeSpaceBytes(1073741824n, 'zh')).toBe('1 GB')
  expect(formatKnowledgeSpaceBytes(1572864n, 'zh')).toBe('1.5 MB')
  const large = {
    ...quota,
    limits: { ...quota.limits!, bytes: '18014398509481986' },
    active: { ...quota.active, bytes: '9007199254740993' },
    reserved: { ...quota.reserved, bytes: '0' },
  }
  expect(knowledgeSpaceUsage(large)?.occupiedPercent).toBe(50)
})

it('fills the occupied bar when fractional used and reserved shares reach capacity', () => {
  const full = {
    ...quota,
    limits: { ...quota.limits!, bytes: '3' },
    active: { ...quota.active, bytes: '1' },
    reserved: { ...quota.reserved, bytes: '2' },
  }
  const usage = knowledgeSpaceUsage(full)!
  expect(usage.occupiedPercent).toBe(100)
  expect(usage.usedPercent + usage.reservedPercent).toBe(100)
  expect(usage.remaining).toBe(0n)
})
