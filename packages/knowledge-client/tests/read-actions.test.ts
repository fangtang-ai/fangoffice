import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeClient } from '../src'
import { fixtureAccount, spaceId } from './fixtures'

const documentId = '019a1234-0000-7000-8000-000000000003'
const versionId = '019a1234-0000-7000-8000-000000000004'
const buildId = '019a1234-0000-7000-8000-000000000005'
const operationId = '019a1234-0000-7000-8000-000000000006'
const parent = { spaceId, documentId }
const version = {
  id: versionId,
  ...parent,
  operationId,
  versionNo: '1',
  format: 'txt',
  sizeBytes: '9007199254740993',
  sha256: 'a'.repeat(64),
  purgedAt: null,
}
const build = {
  id: buildId,
  ...parent,
  versionId,
  operationId,
  indexProfileId: spaceId,
  parserRevision: 'synthetic-1',
  expectedGeneration: '1',
  jobId: operationId,
  retryCount: 0,
  status: 'sealed',
  manifestHash: 'b'.repeat(64),
}
const operation = {
  id: operationId,
  ...parent,
  kind: 'upload',
  phase: 'ready',
  expectedGeneration: '1',
  targetVersionId: versionId,
  error: null,
}
const quota = {
  ownerState: 'active',
  activeIndexProfileId: null,
  policyRevision: null,
  updatedAt: '2026-10-15T00:00:00.000Z',
  limits: null,
  active: { files: '1', bytes: '9007199254740993', chunks: '0' },
  reserved: { files: '0', bytes: '0', chunks: '0' },
  physical: { accountedBytes: '9007199254740993', reservedBytes: '0', limitBytes: '0' },
}

afterEach(() => vi.restoreAllMocks())

it('reads exact historical version, build and operation using full parent targets', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(version))
    .mockResolvedValueOnce(Response.json(build))
    .mockResolvedValueOnce(Response.json(operation))
  const { access } = fixtureAccount()
  const client = createKnowledgeClient(access)
  expect(await client.getVersion({ ...parent, versionId })).toEqual(version)
  expect(await client.getBuild({ ...parent, versionId, buildId })).toEqual(build)
  expect(await client.getOperation({ ...parent, operationId })).toEqual(operation)
  expect(network.mock.calls.map(([url]) => String(url))).toEqual([
    `https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${documentId}/versions/${versionId}`,
    `https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${documentId}/versions/${versionId}/builds/${buildId}`,
    `https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${documentId}/operations/${operationId}`,
  ])
})

it('lists validated versions and reads quota without fabricating configured rights', async () => {
  const result = { items: [version], nextCursor: null }
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(result))
    .mockResolvedValueOnce(Response.json(quota))
  const { access } = fixtureAccount()
  const client = createKnowledgeClient(access)
  expect(await client.listVersions(parent)).toEqual(result)
  expect(await client.getQuota()).toEqual(quota)
  expect(String(network.mock.calls[1]?.[0])).toBe('https://account.invalid/api/knowledge/quota')
})

it('rejects another build or operation even if it belongs to the same document', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ ...build, id: spaceId }))
    .mockResolvedValueOnce(Response.json({ ...operation, id: spaceId }))
  const { access } = fixtureAccount()
  const client = createKnowledgeClient(access)
  await expect(client.getBuild({ ...parent, versionId, buildId })).rejects.toMatchObject({
    code: 'knowledge:invalid-response',
  })
  await expect(client.getOperation({ ...parent, operationId })).rejects.toMatchObject({
    code: 'knowledge:invalid-response',
  })
})
