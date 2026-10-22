import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import * as runtime from '../src/runtime'
import { sourceStoreFixture } from './upload-source-fixtures'
import {
  textUploadInput,
  verificationOptions,
  verificationPolicy,
} from './upload-verification-fixtures'

it('saves verified text by conditional copy and verifies the actual immutable target bytes', async () => {
  const input = textUploadInput([Buffer.from('test')])
  const key = `originals/${'a'.repeat(64)}/${input.prepared.operation.documentId}/${input.prepared.operation.id}`
  const copy = vi.fn(async () => 'copied' as const)
  const body = Readable.from([Buffer.from('te'), Buffer.from('st')])
  const read = vi.fn(async () => ({ ...input.object, key, etag: '"target-revision"', body }))
  const result = await runtime.saveKnowledgeTextUpload(
    input,
    { copy, read },
    verificationPolicy,
    verificationOptions,
  )
  expect(copy).toHaveBeenCalledExactlyOnceWith({
    sourceKey: input.object.key,
    sourceEtag: '"synthetic-object-revision"',
    key,
    mimeType: 'text/plain',
    forbidOverwrite: true,
    privateAcl: true,
    replaceMetadata: true,
    signal: expect.any(AbortSignal),
  })
  expect(read).toHaveBeenCalledExactlyOnceWith({ key, signal: expect.any(AbortSignal) })
  expect(result).toEqual({
    status: 'stored_source',
    key,
    etag: '"target-revision"',
    format: 'txt',
    sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    sourceBytes: '4',
    mimeType: 'text/plain',
  })
  expect(body.destroyed).toBe(true)
  expect(input.object.body.destroyed).toBe(true)
  expect(input.prepared.operation.phase).toBe('uploading')
})

it('rechecks actual target bytes when an earlier attempt already copied the object', async () => {
  const fixture = sourceStoreFixture()
  fixture.copy.mockResolvedValue('exists')
  await expect(
    runtime.saveKnowledgeTextUpload(
      fixture.input,
      fixture,
      verificationPolicy,
      verificationOptions,
    ),
  ).resolves.toMatchObject({ status: 'stored_source', key: fixture.key })
  expect(fixture.copy).toHaveBeenCalledOnce()
  expect(fixture.read).toHaveBeenCalledOnce()
})

it.each(['copied', 'exists'] as const)(
  'refuses same-length target tampering after %s',
  async (result) => {
    const fixture = sourceStoreFixture()
    fixture.copy.mockResolvedValue(result)
    fixture.target.body = Readable.from([Buffer.from('evil')])
    await expect(
      runtime.saveKnowledgeTextUpload(
        fixture.input,
        fixture,
        verificationPolicy,
        verificationOptions,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fixture.target.body.destroyed).toBe(true)
  },
)

it('refuses a changed staging revision without reading or overwriting the target', async () => {
  const fixture = sourceStoreFixture()
  fixture.copy.mockResolvedValue('source_changed')
  await expect(
    runtime.saveKnowledgeTextUpload(
      fixture.input,
      fixture,
      verificationPolicy,
      verificationOptions,
    ),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  expect(fixture.read).not.toHaveBeenCalled()
})

it.each(['key', 'contentLength', 'contentType', 'contentEncoding', 'etag'] as const)(
  'refuses inconsistent target %s and destroys its stream',
  async (field) => {
    const fixture = sourceStoreFixture()
    const object = {
      ...fixture.target,
      [field]: {
        key: `${fixture.key}/other`,
        contentLength: 5n,
        contentType: 'application/pdf',
        contentEncoding: 'gzip',
        etag: 'unsafe\nrevision',
      }[field],
    }
    fixture.read.mockResolvedValue(object)
    await expect(
      runtime.saveKnowledgeTextUpload(
        fixture.input,
        fixture,
        verificationPolicy,
        verificationOptions,
      ),
    ).rejects.toMatchObject({
      code:
        field === 'contentType' || field === 'contentEncoding'
          ? 'UNSUPPORTED_FORMAT'
          : 'SERVICE_UNAVAILABLE',
    })
    expect(fixture.target.body.destroyed).toBe(true)
  },
)

it.each([0, -1, 300001, Number.NaN])(
  'rejects an invalid total timeout without object I/O, case %#',
  async (timeoutMs) => {
    const fixture = sourceStoreFixture()
    await expect(
      runtime.saveKnowledgeTextUpload(
        fixture.input,
        fixture,
        { ...verificationPolicy, timeoutMs },
        verificationOptions,
      ),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.read).not.toHaveBeenCalled()
    expect(fixture.input.object.body.destroyed).toBe(true)
  },
)

it('does not copy bytes that failed staging verification', async () => {
  const fixture = sourceStoreFixture()
  fixture.input.sourceHash = 'b'.repeat(64)
  await expect(
    runtime.saveKnowledgeTextUpload(
      fixture.input,
      fixture,
      verificationPolicy,
      verificationOptions,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(fixture.copy).not.toHaveBeenCalled()
  expect(fixture.read).not.toHaveBeenCalled()
})

it('pins server preparation and object identity before consuming the source', async () => {
  const fixture = sourceStoreFixture()
  fixture.input.object.body = Readable.from(
    (async function* () {
      fixture.input.prepared.staging.key = 'staging/changed'
      fixture.input.prepared.operation = {
        ...fixture.input.prepared.operation,
        documentId: 'changed',
      }
      fixture.input.object.etag = '"changed"'
      fixture.input.sourceHash = 'b'.repeat(64)
      yield Buffer.from('test')
    })(),
  )
  await expect(
    runtime.saveKnowledgeTextUpload(
      fixture.input,
      fixture,
      verificationPolicy,
      verificationOptions,
    ),
  ).resolves.toMatchObject({ status: 'stored_source', key: fixture.key })
  expect(fixture.copy.mock.calls[0]?.[0]).toMatchObject({
    key: fixture.key,
    sourceEtag: '"synthetic-object-revision"',
  })
})

it.each(['../other', '', '019a1234-0000-7000-8000-000000000002/other'])(
  'refuses unsafe server document identity, case %#',
  async (documentId) => {
    const fixture = sourceStoreFixture()
    fixture.input.prepared.operation = { ...fixture.input.prepared.operation, documentId }
    await expect(
      runtime.saveKnowledgeTextUpload(
        fixture.input,
        fixture,
        verificationPolicy,
        verificationOptions,
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(fixture.copy).not.toHaveBeenCalled()
    expect(fixture.input.object.body.destroyed).toBe(true)
  },
)
