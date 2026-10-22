import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeClient } from '../src'
import { deferred, fixtureAccount, space, spaceId } from './fixtures'

afterEach(() => vi.restoreAllMocks())

const documentId = '019a1234-0000-7000-8000-000000000002'
const operationId = '019a1234-0000-7000-8000-000000000003'
const target = { spaceId, documentId }
const metadata = { title: 'Synthetic TXT', tags: ['synthetic'], purpose: 'facts' }
const document = {
  id: documentId,
  spaceId,
  ...metadata,
  generation: '0',
  active: null,
  desired: null,
  deletedAt: null,
}
const upload = {
  operationId,
  idempotencyKey: 'synthetic-upload',
  expectedGeneration: '0',
  declaredBytes: '4',
  format: 'txt',
}
const prepared = {
  operation: {
    id: operationId,
    ...target,
    kind: 'upload',
    phase: 'uploading',
    expectedGeneration: '0',
    targetVersionId: null,
    error: null,
  },
  preparation: {
    status: 'prepared',
    maximumBytes: '4',
    format: 'txt',
    expiresAt: '2026-10-20T12:15:00.000Z',
  },
}

it('completes an upload with the original declaration and hash through a fixed account-bound action', async () => {
  const body = { ...upload, sourceHash: 'a'.repeat(64) }
  const completed = { operation: { ...prepared.operation, phase: 'queued', targetVersionId: '019a1234-0000-7000-8000-000000000004' } }
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(completed))
  const { access } = fixtureAccount()
  expect(await createKnowledgeClient(access).completeUpload(target, body)).toEqual(completed)
  const [url, init] = network.mock.calls[0]!
  expect(String(url)).toBe(`https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${documentId}/uploads/completion`)
  expect(init?.method).toBe('POST')
  expect(JSON.parse(String(init?.body))).toEqual(body)
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-token-A')
  expect(init?.credentials).toBe('omit')
  expect(init?.redirect).toBe('error')
})

it('creates metadata and prepares an upload through fixed account-bound JSON actions', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(space))
    .mockResolvedValueOnce(Response.json(document))
    .mockResolvedValueOnce(Response.json(prepared))
  const { access } = fixtureAccount()
  const client = createKnowledgeClient(access)
  expect(await client.createSpace({ spaceId }, { title: space.title })).toEqual(space)
  expect(await client.createDocument(target, metadata)).toEqual(document)
  expect(await client.prepareUpload(target, upload)).toEqual(prepared)
  expect(network.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    [`https://account.invalid/api/knowledge/spaces/${spaceId}`, 'PUT'],
    [`https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${documentId}`, 'PUT'],
    [
      `https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${documentId}/uploads`,
      'POST',
    ],
  ])
  for (const [, init] of network.mock.calls) {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-token-A')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
  }
  expect(JSON.parse(String(network.mock.calls[2]![1]?.body))).toEqual(upload)
})

it('refreshes a rejected token without changing the upload identity or body', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json(prepared))
  const { access, token } = fixtureAccount()
  await expect(createKnowledgeClient(access).prepareUpload(target, upload)).resolves.toEqual(
    prepared,
  )
  expect(token).toHaveBeenCalledTimes(2)
  expect(network.mock.calls[0]![1]?.body).toBe(network.mock.calls[1]![1]?.body)
  expect(new Headers(network.mock.calls[1]![1]?.headers).get('Authorization')).toBe(
    'Bearer synthetic-renewed-token-A',
  )
})

it('rejects injected metadata and upload fields before acquiring an account token', async () => {
  const network = vi.spyOn(globalThis, 'fetch')
  const { access, token } = fixtureAccount()
  const client = createKnowledgeClient(access)
  await expect(
    client.createSpace({ spaceId }, { title: 'Synthetic', ownerId: 'forged' }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(
    client.createDocument(target, { ...metadata, bucket: 'forged' }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(client.prepareUpload(target, { ...upload, key: 'forged' })).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  })
  expect(token).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
})

it('rejects a space response belonging to a different requested resource', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...space, id: documentId }))
  const { access } = fixtureAccount()
  await expect(
    createKnowledgeClient(access).createSpace({ spaceId }, { title: space.title }),
  ).rejects.toMatchObject({ code: 'knowledge:invalid-response' })
})

it('does not retry an in-flight mutation under a switched account', async () => {
  const pending = deferred<Response>()
  const network = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending.promise)
  const { access, switchAccount } = fixtureAccount()
  const result = createKnowledgeClient(access).prepareUpload(target, upload)
  const rejected = expect(result).rejects.toMatchObject({ code: 'knowledge:account-changed' })
  await vi.waitFor(() => expect(network).toHaveBeenCalledOnce())
  switchAccount()
  pending.resolve(new Response(null, { status: 401 }))
  await rejected
  expect(network).toHaveBeenCalledOnce()
})
