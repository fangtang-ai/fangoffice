import { expect, it, vi } from 'vitest'
import { createKnowledgeOssSourceStore, parseKnowledgeOssUploadConfig } from '../src/runtime'
import { ossUploadEnvironment, ossUploadNow, ossUploadPrepared } from './oss-upload-fixtures'

const sourceKey = ossUploadPrepared.staging.key
const originalKey = `originals/${'a'.repeat(64)}/${ossUploadPrepared.operation.documentId}/${ossUploadPrepared.operation.id}`
const copyRequest = {
  sourceKey,
  sourceEtag: '"rev"',
  key: originalKey,
  mimeType: 'text/plain',
  forbidOverwrite: true,
  privateAcl: true,
  replaceMetadata: true,
  signal: AbortSignal.timeout(10000),
} as const

it('conditionally copies the verified revision without overwriting or inheriting metadata', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(
      new Response(
        '<CopyObjectResult><ETag>"target"</ETag><LastModified>2026-10-20T12:00:00.000Z</LastModified></CopyObjectResult>',
      ),
    )
  const store = createKnowledgeOssSourceStore(
    parseKnowledgeOssUploadConfig(ossUploadEnvironment, ossUploadNow)!,
    { now: () => ossUploadNow, fetch },
  )
  await expect(store.copy(copyRequest)).resolves.toBe('copied')
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe(
    `https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com/${originalKey}`,
  )
  expect(init).toMatchObject({ method: 'PUT', redirect: 'error', signal: copyRequest.signal })
  expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
    'x-oss-copy-source': `/synthetic-private-knowledge/${sourceKey}`,
    'x-oss-copy-source-if-match': '"rev"',
    'x-oss-forbid-overwrite': 'true',
    'x-oss-object-acl': 'private',
    'x-oss-metadata-directive': 'REPLACE',
    'content-type': 'text/plain',
  })
  expect(new Headers(init?.headers).get('authorization')).toBe(
    'OSS4-HMAC-SHA256 Credential=synthetic-sts-id/20261020/cn-hangzhou/oss/aliyun_v4_request,Signature=585117a021ea702c47e391411c93c2e622f3fb3367e61ce566a14892dbce2ff7',
  )
})

it('reads a fixed private staging object through a signed V4 streaming request', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response('test', {
      headers: { 'content-length': '4', 'content-type': 'application/octet-stream', etag: '"rev"' },
    }),
  )
  const store = createKnowledgeOssSourceStore(
    parseKnowledgeOssUploadConfig(ossUploadEnvironment, ossUploadNow)!,
    { now: () => ossUploadNow, fetch },
  )
  const signal = AbortSignal.timeout(1000)
  const object = await store.read({ key: ossUploadPrepared.staging.key, signal })
  expect(object).toMatchObject({
    key: ossUploadPrepared.staging.key,
    contentLength: 4n,
    contentType: 'application/octet-stream',
    etag: '"rev"',
  })
  const chunks: Buffer[] = []
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString()).toBe('test')
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe(
    `https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com/${ossUploadPrepared.staging.key}`,
  )
  expect(init).toMatchObject({ method: 'GET', redirect: 'error', signal })
  expect(new Headers(init?.headers).get('x-oss-security-token')).toBe('synthetic-sts-token')
  expect(new Headers(init?.headers).get('authorization')).toBe(
    'OSS4-HMAC-SHA256 Credential=synthetic-sts-id/20261020/cn-hangzhou/oss/aliyun_v4_request,Signature=43906e639c44f3b40233c8d66c3eba44067770a55a904a6e225a0fd6a7a748ca',
  )
})
