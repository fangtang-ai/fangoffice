import { expect, it } from 'vitest'
import { verifyKnowledgeTextUpload } from '../src/runtime'
import { ossUploadNow } from './oss-upload-fixtures'
import {
  textUploadInput,
  verificationOptions,
  verificationPolicy,
} from './upload-verification-fixtures'

it.each([
  { maximumFileBytes: 0n },
  { maximumFileBytes: -1n },
  { maximumFileBytes: 9223372036854775808n },
  { timeoutMs: 0 },
  { timeoutMs: -1 },
  { timeoutMs: 1.5 },
  { timeoutMs: 300001 },
  { timeoutMs: Number.NaN },
])('requires explicit bounded server limits before reading, case %#', async (override) => {
  const input = textUploadInput([Buffer.from('test')])
  await expect(
    verifyKnowledgeTextUpload(input, { ...verificationPolicy, ...override }, verificationOptions),
  ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  expect(input.object.body.readableDidRead).toBe(false)
  expect(input.object.body.destroyed).toBe(true)
})

it.each([
  { key: 'staging/another-owner/object' },
  { etag: '' },
  { etag: ' ' },
  { etag: 'revision\r\nforged-header' },
  { etag: 'x'.repeat(257) },
  { contentLength: 3n },
  { contentLength: -1n },
])('rejects inconsistent trusted object metadata, case %#', async (override) => {
  const input = textUploadInput([Buffer.from('test')])
  Object.assign(input.object, override)
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(input.object.body.readableDidRead).toBe(false)
  expect(input.object.body.destroyed).toBe(true)
})

it.each([
  { contentType: 'text/html' },
  { contentType: 'text/plain; charset=utf-16' },
  { contentType: 'image/png' },
  { contentEncoding: 'gzip' },
])(
  'refuses a conflicting MIME or encoded representation before reading, case %#',
  async (override) => {
    const input = textUploadInput([Buffer.from('test')])
    Object.assign(input.object, override)
    await expect(
      verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
    expect(input.object.body.readableDidRead).toBe(false)
    expect(input.object.body.destroyed).toBe(true)
  },
)

it.each(['pdf', 'docx', 'xlsx'] as const)(
  'does not substitute a text check for unimplemented %s container verification',
  async (format) => {
    const input = textUploadInput([Buffer.from('test')])
    input.prepared.staging.format = format
    await expect(
      verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
    expect(input.object.body.readableDidRead).toBe(false)
  },
)

it.each([
  { key: 'staging/forged/object' },
  { key: `staging/${'a'.repeat(64)}/019a1234-0000-7000-8000-000000000004` },
  { maximumBytes: '0' },
  { maximumBytes: '04' },
  { maximumBytes: '9223372036854775808' },
])('refuses malformed trusted staging facts, case %#', async (override) => {
  const input = textUploadInput([Buffer.from('test')])
  Object.assign(input.prepared.staging, override)
  await expect(
    verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(input.object.body.readableDidRead).toBe(false)
})

it('keeps byte declarations above 2^53 exact when comparing provider metadata', async () => {
  const input = textUploadInput([Buffer.from('test')])
  input.prepared.staging.maximumBytes = '9007199254740993'
  input.object.contentLength = 9007199254740992n
  await expect(
    verifyKnowledgeTextUpload(
      input,
      { ...verificationPolicy, maximumFileBytes: 9223372036854775807n },
      verificationOptions,
    ),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(input.object.body.readableDidRead).toBe(false)
})

it.each(['', 'a'.repeat(63), 'A'.repeat(64), '../injected'])(
  'rejects malformed expected hashes before reading, case %#',
  async (sourceHash) => {
    const input = textUploadInput([Buffer.from('test')])
    input.sourceHash = sourceHash
    await expect(
      verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(input.object.body.readableDidRead).toBe(false)
  },
)

it('refuses excess server size, expired sessions and non-uploading operations before I/O', async () => {
  const oversized = textUploadInput([Buffer.from('test')])
  await expect(
    verifyKnowledgeTextUpload(
      oversized,
      { ...verificationPolicy, maximumFileBytes: 3n },
      verificationOptions,
    ),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  const expired = textUploadInput([Buffer.from('test')])
  expired.prepared.staging.expiresAt = new Date(ossUploadNow).toISOString()
  const closed = textUploadInput([Buffer.from('test')])
  closed.prepared.operation = { ...closed.prepared.operation, phase: 'failed' }
  for (const input of [expired, closed]) {
    await expect(
      verifyKnowledgeTextUpload(input, verificationPolicy, verificationOptions),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(input.object.body.readableDidRead).toBe(false)
    expect(input.object.body.destroyed).toBe(true)
  }
})
