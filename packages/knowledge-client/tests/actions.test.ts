import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeClient } from '../src'
import { fixtureAccount, spaceId } from './fixtures'

const documentId = '019a1234-0000-7000-8000-000000000003'
const target = { spaceId, documentId }
const document = {
  id: documentId,
  spaceId,
  title: '合成资料',
  tags: [],
  purpose: 'facts',
  generation: '1',
  active: null,
  desired: null,
  deletedAt: null,
}

afterEach(() => vi.restoreAllMocks())

it('lists documents using the fixed parent route and validated pagination', async () => {
  const result = { items: [document], nextCursor: null }
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result))
  const { access } = fixtureAccount()
  expect(await createKnowledgeClient(access).listDocuments({ spaceId }, { limit: 5 })).toEqual(
    result,
  )
  expect(String(network.mock.calls[0]?.[0])).toBe(
    `https://account.invalid/api/knowledge/spaces/${spaceId}/documents?limit=5`,
  )
})

it('reads only the exact document requested instead of accepting another valid DTO', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(document))
    .mockResolvedValueOnce(Response.json({ ...document, id: spaceId }))
  const { access } = fixtureAccount()
  const client = createKnowledgeClient(access)
  expect(await client.getDocument(target)).toEqual(document)
  expect(String(network.mock.calls[0]?.[0])).toBe(
    `https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${documentId}`,
  )
  await expect(client.getDocument(target)).rejects.toMatchObject({
    code: 'knowledge:invalid-response',
  })
})

it.each([
  { spaceId: '../outside' },
  { spaceId, url: 'https://outside.invalid' },
  { spaceId, owner: 'forged' },
])('rejects a forged route before account or network access', async (input) => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ items: [], nextCursor: null }))
  const { access, token } = fixtureAccount()
  await expect(createKnowledgeClient(access).listDocuments(input)).rejects.toThrow()
  expect(network).not.toHaveBeenCalled()
  expect(token).not.toHaveBeenCalled()
})
