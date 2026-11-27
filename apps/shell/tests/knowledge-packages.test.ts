import { expect, it, vi } from 'vitest'
import { fetchKnowledgeExpansionPacks } from '../src/main/knowledge-packages'
import { readKnowledgeExpansionPacks } from '../src/shared/knowledge-packages'

const pack = {
  id: 'knowledge-service-light',
  product: 'knowledge_base',
  name: '知识库轻量扩容包',
  priceFen: 990,
  knowledgePlan: { storageMiB: 128, permanent: true },
}

it('reads current knowledge packs from the configured site without credentials or an order request', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { packages: [pack] } })))
  expect(await fetchKnowledgeExpansionPacks('https://test.example.com', request)).toEqual([
    { id: pack.id, name: pack.name, priceFen: 990, storageMiB: 128 },
  ])
  expect(request).toHaveBeenCalledTimes(1)
  const [url, options] = request.mock.calls[0]!
  expect(String(url)).toBe(
    'https://test.example.com/api/billing/office-packages?product=knowledge_base',
  )
  expect(options?.redirect).toBe('error')
  expect(options?.headers).toBeUndefined()
  expect(options?.method).toBeUndefined()
})

it('uses updated server prices and ignores legacy wallet or monthly products', () => {
  expect(
    readKnowledgeExpansionPacks([
      { ...pack, knowledgePlan: null },
      { ...pack, knowledgePlan: { storageMiB: 128, durationMonths: 1 } },
      { ...pack, priceFen: 1290 },
    ])[0]?.priceFen,
  ).toBe(1290)
  expect(readKnowledgeExpansionPacks([])).toEqual([])
})

it.each([
  { ...pack, product: 'office_ai' },
  { ...pack, priceFen: -1 },
  { ...pack, priceFen: 9.9 },
  { ...pack, knowledgePlan: { permanent: true, storageMiB: 0 } },
  { ...pack, knowledgePlan: { permanent: true, storageMiB: 10241 } },
])('rejects malformed or cross-product pricing: $product $priceFen', (invalid) => {
  expect(() => readKnowledgeExpansionPacks([invalid])).toThrow()
})

it('rejects duplicate identities, broken responses and unsafe configured URLs', async () => {
  expect(() => readKnowledgeExpansionPacks([pack, pack])).toThrow()
  const request = vi.fn<typeof fetch>()
  await expect(fetchKnowledgeExpansionPacks(undefined, request)).rejects.toThrow()
  await expect(fetchKnowledgeExpansionPacks('http://remote.example.com', request)).rejects.toThrow()
  await expect(
    fetchKnowledgeExpansionPacks('https://user:secret@example.com', request),
  ).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
  request.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  await expect(fetchKnowledgeExpansionPacks('http://localhost:4780', request)).rejects.toThrow()
  request.mockResolvedValueOnce(
    new Response(JSON.stringify({ success: false, data: { packages: [pack] } })),
  )
  await expect(fetchKnowledgeExpansionPacks('http://localhost:4780', request)).rejects.toThrow()
})
