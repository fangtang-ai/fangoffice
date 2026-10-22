import { expect, it, vi } from 'vitest'
import { createKnowledgeOssSourceStore } from '../src/runtime'
import { ossUploadNow } from './oss-upload-fixtures'
import { ossCopyRequest, ossSourceFixture, ossSourceKey } from './oss-source-fixtures'

it.each([
  { bucket: 'wrong.example/@target' },
  { region: 'cn-hangzhou-internal' },
  { accessKeyId: 'injected\nheader' },
  { credentialExpiresAt: 'invalid' },
])('rejects untrusted storage configuration before constructing a transport, case %#', (change) => {
  const { config, fetch } = ossSourceFixture()
  expect(() =>
    createKnowledgeOssSourceStore({ ...config, ...change }, { now: () => ossUploadNow, fetch }),
  ).toThrowError(expect.objectContaining({ code: 'NOT_CONFIGURED' }))
  expect(fetch).not.toHaveBeenCalled()
})

it('disposes a late read response after cancellation rather than leaking an object stream', async () => {
  const cancelled = vi.fn()
  const response = new Response(new ReadableStream({ cancel: cancelled }), {
    headers: { 'content-length': '4', 'content-type': 'text/plain', etag: '"rev"' },
  })
  const { config } = ossSourceFixture()
  const controller = new AbortController()
  const store = createKnowledgeOssSourceStore(config, {
    now: () => ossUploadNow,
    fetch: async () => {
      controller.abort()
      return response
    },
  })
  await expect(store.read({ key: ossSourceKey, signal: controller.signal })).rejects.toMatchObject({
    code: 'CANCELLED',
  })
  expect(cancelled).toHaveBeenCalledOnce()
})

it('refuses a redirected object response even from a transport that ignored redirect policy', async () => {
  const response = new Response('test', {
    headers: { 'content-length': '4', 'content-type': 'text/plain', etag: '"rev"' },
  })
  Object.defineProperty(response, 'redirected', { value: true })
  const { store } = ossSourceFixture(response)
  await expect(
    store.read({ key: ossSourceKey, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(response.bodyUsed).toBe(true)
})

it('rejects copy requests outside the prepared owner and operation before network I/O', async () => {
  const { store, fetch } = ossSourceFixture()
  await expect(
    store.copy({
      ...ossCopyRequest(),
      key: ossCopyRequest().key.replace('a'.repeat(64), 'b'.repeat(64)),
    }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(fetch).not.toHaveBeenCalled()
})

it('rechecks STS expiry before each object request without issuing a stale signature', async () => {
  const { config, fetch } = ossSourceFixture()
  let current = ossUploadNow
  const store = createKnowledgeOssSourceStore(config, { now: () => current, fetch })
  current = Date.parse(config.credentialExpiresAt) - 60000
  await expect(
    store.read({ key: ossSourceKey, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  '../outside',
  '/staging/key',
  `${ossSourceKey}?versionId=untrusted`,
  `https://elsewhere/${ossSourceKey}`,
])('rejects an unrestricted object path %s before I/O', async (key) => {
  const { store, fetch } = ossSourceFixture()
  await expect(store.read({ key, signal: new AbortController().signal })).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  })
  expect(fetch).not.toHaveBeenCalled()
})

it('pins storage configuration against mutation during later external I/O', async () => {
  const { config: original, fetch } = ossSourceFixture(
    new Response('test', {
      headers: { 'content-length': '4', 'content-type': 'text/plain', etag: '"rev"' },
    }),
  )
  const config = { ...original }
  const store = createKnowledgeOssSourceStore(config, { now: () => ossUploadNow, fetch })
  config.bucket = 'another-bucket'
  config.securityToken = 'changed-token'
  const result = await store.read({ key: ossSourceKey, signal: new AbortController().signal })
  result.body.destroy()
  expect(fetch.mock.calls[0]![0]).toBe(
    `https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com/${ossSourceKey}`,
  )
  expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('x-oss-security-token')).toBe(
    'synthetic-sts-token',
  )
})

it('redacts transport failures rather than exposing signed request credentials', async () => {
  const { config } = ossSourceFixture()
  const store = createKnowledgeOssSourceStore(config, {
    now: () => ossUploadNow,
    fetch: async () => {
      throw new Error('synthetic-sts-secret synthetic-sts-token')
    },
  })
  await expect(
    store.read({ key: ossSourceKey, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE' })
})
