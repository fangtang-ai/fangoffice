import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadFangTangAccountConfig } from '../src/factory-defaults'

const fixture = vi.hoisted(() => ({ account: {} as Record<string, string> }))
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify({ account: fixture.account }),
}))

beforeEach(() => {
  fixture.account = {
    accountApiBase: 'https://account.invalid',
    knowledgeApiBase: 'https://account.invalid/api/knowledge',
  }
  vi.stubEnv('FANGTANG_ACCOUNT_API_BASE', '')
  vi.stubEnv('FANGTANG_KNOWLEDGE_API_BASE', '')
})
afterEach(() => vi.unstubAllEnvs())

it('loads explicit knowledge deployment configuration without reading real configuration files', () => {
  expect(loadFangTangAccountConfig().knowledgeApiBase).toBe('https://account.invalid/api/knowledge')
})

it('allows an explicit environment override while leaving target validation to the client', () => {
  vi.stubEnv('FANGTANG_KNOWLEDGE_API_BASE', 'https://different.invalid/api/knowledge')
  expect(loadFangTangAccountConfig().knowledgeApiBase).toBe(
    'https://different.invalid/api/knowledge',
  )
})

it('does not infer knowledge deployment from the account origin', () => {
  delete fixture.account.knowledgeApiBase
  expect(loadFangTangAccountConfig().knowledgeApiBase).toBeUndefined()
})
