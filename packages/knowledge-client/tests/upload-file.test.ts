import { afterEach, expect, it, vi } from 'vitest'
import { createKnowledgeClient } from '../src'
import { deferred, fixtureAccount, spaceId } from './fixtures'

afterEach(() => vi.restoreAllMocks())

const target = { spaceId, documentId: '019a1234-0000-7000-8000-000000000002' }
const declaration = {
  operationId: '019a1234-0000-7000-8000-000000000003',
  idempotencyKey: 'synthetic-upload',
  expectedGeneration: '0',
  declaredBytes: '4',
  format: 'txt',
}
const grant = {
  operation: {
    id: declaration.operationId,
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
    expiresAt: '2030-10-20T12:15:00.000Z',
  },
  upload: {
    url: 'https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com/',
    expiresAt: '2030-10-20T12:05:00.000Z',
    fields: {
      key: `staging/${'a'.repeat(64)}/${declaration.operationId}`,
      'Content-Type': 'application/octet-stream',
      'x-oss-signature-version': 'OSS4-HMAC-SHA256',
      'x-oss-credential': 'synthetic-id/20301020/cn-hangzhou/oss/aliyun_v4_request',
      'x-oss-date': '20301020T120000Z',
      'x-oss-security-token': 'synthetic-token',
      'x-oss-forbid-overwrite': 'true',
      'x-oss-object-acl': 'private',
      success_action_status: '204',
      policy: 'eyJzeW50aGV0aWMiOnRydWV9',
      'x-oss-signature': 'a'.repeat(64),
    },
  },
}

it('uploads an explicit Blob only to the scoped form target without account credentials', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  const { access } = fixtureAccount()
  const result = await createKnowledgeClient(access).uploadFile(
    target,
    declaration,
    new Blob(['test']),
  )
  expect(result.transfer.status).toBe('uploaded_to_staging')
  expect(result.operation.phase).toBe('uploading')
  expect(String(network.mock.calls[0]![0])).toBe(
    `https://account.invalid/api/knowledge/spaces/${spaceId}/documents/${target.documentId}/uploads/authorization`,
  )
  const [url, init] = network.mock.calls[1]!
  expect(String(url)).toBe(grant.upload.url)
  expect(init?.method).toBe('POST')
  expect(init?.headers).toBeUndefined()
  expect(init?.credentials).toBe('omit')
  expect(init?.redirect).toBe('error')
  const form = init?.body as FormData
  expect([...form.keys()].at(-1)).toBe('file')
  expect(form.get('key')).toBe(grant.upload.fields.key)
  expect(await (form.get('file') as Blob).text()).toBe('test')
})

it('rejects size mismatch before authentication and never retries an OSS 401 using an account token', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
  const { access, token } = fixtureAccount()
  const client = createKnowledgeClient(access)
  await expect(
    client.uploadFile(target, declaration, new Blob(['wrong-size'])),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(network).not.toHaveBeenCalled()
  await expect(client.uploadFile(target, declaration, new Blob(['test']))).rejects.toMatchObject({
    code: 'knowledge:request-failed',
  })
  expect(network).toHaveBeenCalledTimes(2)
  expect(token).toHaveBeenCalledOnce()
})

it.each([
  { ...grant.upload, url: 'https://untrusted.invalid/' },
  { ...grant.upload, fields: { ...grant.upload.fields, 'x-oss-forbid-overwrite': 'false' } },
  { ...grant.upload, fields: { ...grant.upload.fields, Authorization: 'forged' } },
  { ...grant.upload, fields: { ...grant.upload.fields, key: 'staging/forged' } },
  { ...grant.upload, expiresAt: '2030-10-20T12:16:00.000Z' },
])('rejects an untrusted or wider object capability before transfer %#', async (upload) => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ ...grant, upload }))
  const { access } = fixtureAccount()
  await expect(
    createKnowledgeClient(access).uploadFile(target, declaration, new Blob(['test'])),
  ).rejects.toMatchObject({ code: 'knowledge:invalid-response' })
  expect(network).toHaveBeenCalledOnce()
})

it('cancels an in-flight object transfer when the account changes and discards a late acknowledgment', async () => {
  const pending = deferred<Response>()
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(grant))
    .mockReturnValueOnce(pending.promise)
  const { access, switchAccount } = fixtureAccount()
  const result = createKnowledgeClient(access).uploadFile(target, declaration, new Blob(['test']))
  const rejected = expect(result).rejects.toMatchObject({ code: 'knowledge:account-changed' })
  await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(2))
  switchAccount()
  pending.resolve(new Response(null, { status: 204 }))
  await rejected
  expect(network.mock.calls[1]![1]?.signal?.aborted).toBe(true)
  expect(network).toHaveBeenCalledTimes(2)
})
