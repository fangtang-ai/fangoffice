import { expect, it } from 'vitest'
import {
  createKnowledgeOssSourceStore,
  parseKnowledgeOssUploadConfig,
  saveKnowledgeTextUpload,
} from '../src/runtime'
import { ossUploadEnvironment, ossUploadNow } from './oss-upload-fixtures'
import { sourceHttpFixture } from './upload-source-http-fixtures'
import {
  textUploadInput,
  verificationOptions,
  verificationPolicy,
} from './upload-verification-fixtures'

it('streams real HTTP staging and original bytes through the production OSS adapter and verifies replay', async () => {
  const fixture = await sourceHttpFixture()
  try {
    expect(fixture.fetch).toBeTypeOf('function')
    const store = createKnowledgeOssSourceStore(
      parseKnowledgeOssUploadConfig(ossUploadEnvironment, ossUploadNow)!,
      { ...verificationOptions, fetch: fixture.fetch },
    )
    const save = async () => {
      const input = textUploadInput([Buffer.from('test')])
      input.object = await store.read({
        key: input.prepared.staging.key,
        signal: AbortSignal.timeout(1000),
      })
      return saveKnowledgeTextUpload(input, store, verificationPolicy, verificationOptions)
    }
    const result = await save()
    expect(result).toMatchObject({
      status: 'stored_source',
      sourceBytes: '4',
      sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    })
    expect(fixture.objects.get(result.key)?.bytes.toString()).toBe('test')
    await expect(save()).resolves.toEqual(result)
    fixture.objects.get(result.key)!.bytes = Buffer.from('evil')
    await expect(save()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fixture.requests.filter((request) => request.method === 'PUT')).toHaveLength(3)
    expect(
      fixture.requests.every(
        (request) =>
          typeof request.headers.authorization === 'string' &&
          request.headers.authorization.startsWith('OSS4-HMAC-SHA256 '),
      ),
    ).toBe(true)
    expect(JSON.stringify(result)).not.toContain('synthetic-sts')
  } finally {
    await fixture.close()
  }
})

it('observes actual HTTP conditional-copy refusal after staging revision changes', async () => {
  const fixture = await sourceHttpFixture()
  try {
    expect(fixture.fetch).toBeTypeOf('function')
    const store = createKnowledgeOssSourceStore(
      parseKnowledgeOssUploadConfig(ossUploadEnvironment, ossUploadNow)!,
      { ...verificationOptions, fetch: fixture.fetch },
    )
    const input = textUploadInput([Buffer.from('test')])
    input.object = await store.read({
      key: input.prepared.staging.key,
      signal: AbortSignal.timeout(1000),
    })
    await expect(
      saveKnowledgeTextUpload(
        input,
        {
          ...store,
          async copy(request) {
            fixture.objects.get(request.sourceKey)!.etag = '"changed"'
            return store.copy(request)
          },
        },
        verificationPolicy,
        verificationOptions,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(fixture.objects.size).toBe(1)
    expect(
      fixture.requests.filter(
        (request) => request.key.startsWith('originals/') && request.method === 'GET',
      ),
    ).toHaveLength(0)
  } finally {
    await fixture.close()
  }
})
