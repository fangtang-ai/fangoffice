import { expect, it } from 'vitest'
import { saveKnowledgeTextUpload } from '../src/runtime'
import { sourceHttpFixture } from './upload-source-http-fixtures'
import { verificationOptions, verificationPolicy } from './upload-verification-fixtures'

it('copies real HTTP object bytes once and refuses a corrupted existing target on replay', async () => {
  const fixture = await sourceHttpFixture()
  try {
    const result = await saveKnowledgeTextUpload(
      await fixture.input(),
      fixture.store,
      verificationPolicy,
      verificationOptions,
    )
    expect(result).toMatchObject({
      status: 'stored_source',
      etag: '"target-http-revision"',
      sourceBytes: '4',
    })
    expect(fixture.objects.get(result.key)?.bytes.toString()).toBe('test')
    await expect(
      saveKnowledgeTextUpload(
        await fixture.input(),
        fixture.store,
        verificationPolicy,
        verificationOptions,
      ),
    ).resolves.toEqual(result)
    fixture.objects.get(result.key)!.bytes = Buffer.from('evil')
    await expect(
      saveKnowledgeTextUpload(
        await fixture.input(),
        fixture.store,
        verificationPolicy,
        verificationOptions,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fixture.objects.get(result.key)?.bytes.toString()).toBe('evil')
    expect(fixture.requests.filter((request) => request.method === 'PUT')).toHaveLength(3)
    expect(
      fixture.requests.filter((request) => request.method === 'GET' && request.key === result.key),
    ).toHaveLength(3)
  } finally {
    await fixture.close()
  }
})

it('rejects an actual HTTP source revision change between verification and conditional copy', async () => {
  const fixture = await sourceHttpFixture()
  try {
    const input = await fixture.input()
    await expect(
      saveKnowledgeTextUpload(
        input,
        {
          ...fixture.store,
          async copy(request) {
            fixture.objects.set(request.sourceKey, {
              bytes: Buffer.from('evil'),
              etag: '"changed-http-revision"',
              mimeType: 'application/octet-stream',
            })
            return fixture.store.copy(request)
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

it('recovers a lost copy acknowledgment without overwriting the stored object', async () => {
  const fixture = await sourceHttpFixture()
  try {
    await expect(
      saveKnowledgeTextUpload(
        await fixture.input(),
        {
          ...fixture.store,
          async copy(request) {
            await fixture.store.copy(request)
            throw new Error('private-provider-copy-ack-lost')
          },
        },
        verificationPolicy,
        verificationOptions,
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'SERVICE_UNAVAILABLE' })
    expect(fixture.objects.size).toBe(2)
    const saved = await saveKnowledgeTextUpload(
      await fixture.input(),
      fixture.store,
      verificationPolicy,
      verificationOptions,
    )
    expect(saved.status).toBe('stored_source')
    expect(fixture.objects.size).toBe(2)
    expect(fixture.objects.get(saved.key)?.etag).toBe('"target-http-revision"')
  } finally {
    await fixture.close()
  }
})
