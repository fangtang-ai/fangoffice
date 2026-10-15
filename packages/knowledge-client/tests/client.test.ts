import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeClient } from '../src'
import { fixtureAccount, page } from './fixtures'

afterEach(() => vi.restoreAllMocks())

it('lists validated spaces only through the fixed account-bound knowledge action', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(page))
  const { access } = fixtureAccount()
  const client = createKnowledgeClient(access)

  expect(await client.listSpaces()).toEqual(page)
  expect(network).toHaveBeenCalledOnce()
  const [url, init] = network.mock.calls[0]!
  expect(String(url)).toBe('https://account.invalid/api/knowledge/spaces?limit=20')
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-token-A')
  expect(init?.redirect).toBe('error')
  expect(init?.credentials).toBe('omit')
})
