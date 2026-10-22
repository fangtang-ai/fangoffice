import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { verifyKnowledgeTextUpload } from '../src/runtime'
import { ossUploadNow, ossUploadPrepared } from './oss-upload-fixtures'
import {
  textUploadInput,
  verificationOptions,
  verificationPolicy,
} from './upload-verification-fixtures'

it('verifies the complete fixed staging text object without publishing a version', async () => {
  const body = Readable.from([Buffer.from('te'), Buffer.from('st')])
  const result = await verifyKnowledgeTextUpload(
    {
      prepared: ossUploadPrepared,
      sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      object: {
        key: ossUploadPrepared.staging.key,
        etag: '"synthetic-object-revision"',
        contentType: 'application/octet-stream',
        contentLength: 4n,
        body,
      },
    },
    { maximumFileBytes: 16n, timeoutMs: 1000 },
    { now: () => ossUploadNow },
  )
  expect(result).toEqual({
    status: 'verified_staging',
    key: ossUploadPrepared.staging.key,
    etag: '"synthetic-object-revision"',
    format: 'txt',
    sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    sourceBytes: '4',
    mimeType: 'text/plain',
  })
  expect(body.destroyed).toBe(true)
  expect(ossUploadPrepared.operation.phase).toBe('uploading')
})

it('validates BOM and multi-byte UTF-8 across single-byte chunks for Markdown', async () => {
  const bytes = Buffer.from('\uFEFF中文😀\r\n# 标题\n')
  const input = textUploadInput(Array.from(bytes, (byte) => Buffer.from([byte])))
  input.prepared.staging.format = 'md'
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).resolves.toMatchObject({ format: 'md', mimeType: 'text/markdown', sourceBytes: '24' })
})

it('hashes the raw bytes, including a BOM, rather than the decoded text', async () => {
  const input = textUploadInput([Buffer.from('\uFEFFtest')])
  input.sourceHash = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
})

it.each([
  { bytes: [0xc3] },
  { bytes: [0xc3, 0x28] },
  { bytes: [0xc0, 0xaf] },
  { bytes: [0xed, 0xa0, 0x80] },
  { bytes: [0xff, 0xfe, 0x61, 0x00] },
])('rejects invalid, truncated or non-UTF-8 text, case %#', async ({ bytes }) => {
  const input = textUploadInput(bytes.map((byte) => Buffer.from([byte])))
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(input.object.body.destroyed).toBe(true)
})

it.each(['\u0000text', 'text\u000b', 'text\u0085', '%PDF-1.7\n%%EOF', 'PK\u0003\u0004'])(
  'refuses binary or PDF content declared as text, case %#',
  async (value) => {
    const input = textUploadInput(Array.from(Buffer.from(value), (byte) => Buffer.from([byte])))
    await expect(
      verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
    expect(input.object.body.destroyed).toBe(true)
  },
)

it.each([' \r\n\t', '\uFEFF'])('does not verify empty text, case %#', async (value) => {
  const input = textUploadInput([Buffer.from(value)])
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).rejects.toMatchObject({ code: 'EMPTY_CONTENT' })
})

it.each([
  { value: 'tes', code: 'INCOMPLETE_CONTENT' },
  { value: 'test!', code: 'INVALID_REQUEST' },
  { value: '', code: 'INCOMPLETE_CONTENT' },
])(
  'checks actual EOF length instead of trusting Content-Length, case %#',
  async ({ value, code }) => {
    const input = textUploadInput([Buffer.from('test')])
    input.object.body = Readable.from([Buffer.from(value)])
    await expect(
      verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
    ).rejects.toMatchObject({ code })
    expect(input.object.body.destroyed).toBe(true)
  },
)

it('rejects a plausible but incorrect client hash after consuming the complete object', async () => {
  const input = textUploadInput([Buffer.from('test')])
  input.sourceHash = '0'.repeat(64)
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
})

it('sanitizes object read failures and rejects non-byte stream chunks', async () => {
  for (const body of [
    Readable.from(
      (async function* () {
        yield Buffer.from('te')
        throw new Error('synthetic-secret-and-private-object-url')
      })(),
    ),
    Readable.from(['test']),
  ]) {
    const input = textUploadInput([Buffer.from('test')])
    input.object.body = body
    await expect(
      verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE' })
    expect(body.destroyed).toBe(true)
  }
})
