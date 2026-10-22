import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ossUploadEnvironment } from '../tests/oss-upload-fixtures'
import { withUploadHttpFixture } from './upload-http-fixtures'
import { uploadMetadata } from './upload-fixtures'
import { changeCapacityFixture } from './capacity-fixtures'
import { syntheticOssFormTarget } from './oss-form-fixtures'

it('transfers real multipart bytes to an explicit synthetic OSS adapter without bearer/cookies or a ready Version', async () => {
  await withUploadHttpFixture(
    async (_fixture, { client, service }) => {
      const target = { spaceId: randomUUID(), documentId: randomUUID() }
      const declaration = {
        operationId: randomUUID(),
        idempotencyKey: randomUUID(),
        expectedGeneration: '0',
        declaredBytes: '4',
        format: 'txt',
      }
      await client.createSpace({ spaceId: target.spaceId }, { title: 'Synthetic' })
      await client.createDocument(target, uploadMetadata)
      const storage = await syntheticOssFormTarget(service.origin)
      try {
        const result = await client.uploadFile(target, declaration, new Blob(['test']))
        expect(result.transfer.status).toBe('uploaded_to_staging')
        expect(result.operation).toMatchObject({ phase: 'uploading', targetVersionId: null })
        expect(storage.objects.size).toBe(1)
        expect(new TextDecoder().decode([...storage.objects.values()][0])).toBe('test')
        await expect(
          client.uploadFile(target, declaration, new Blob(['test'])),
        ).rejects.toMatchObject({ code: 'knowledge:request-failed' })
        expect(storage.objects.size).toBe(1)
        expect(storage.accountHeaders).toEqual(['', ''])
      } finally {
        await storage.close()
      }
    },
    true,
    {
      ...ossUploadEnvironment,
      KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    },
  )
})

it('authorizes only the committed owner session and replays its original immutable object and deadline', async () => {
  await withUploadHttpFixture(
    async (fixture, { client, service, tokenFor, headers }) => {
      const target = { spaceId: randomUUID(), documentId: randomUUID() }
      const declaration = {
        operationId: randomUUID(),
        idempotencyKey: randomUUID(),
        expectedGeneration: '0',
        declaredBytes: '4',
        format: 'txt',
      }
      await client.createSpace({ spaceId: target.spaceId }, { title: 'Synthetic' })
      await client.createDocument(target, uploadMetadata)
      const prepared = await client.prepareUpload(target, declaration)
      const grant = await client.authorizeUpload(target, {
        ...declaration,
        operationId: randomUUID(),
      })
      expect(grant.operation).toEqual(prepared.operation)
      expect(grant.preparation).toEqual(prepared.preparation)
      expect(grant.upload.fields.key.endsWith(`/${prepared.operation.id}`)).toBe(true)
      expect(Date.parse(grant.upload.expiresAt)).toBeLessThanOrEqual(
        Date.parse(prepared.preparation.expiresAt),
      )
      const response = await fetch(
        `${service.origin}/api/knowledge/spaces/${target.spaceId}/documents/${target.documentId}/uploads/authorization`,
        {
          method: 'POST',
          headers: { ...headers, Authorization: `Bearer ${await tokenFor(fixture.owners[1])}` },
          body: JSON.stringify(declaration),
        },
      )
      expect(response.status).toBe(404)
      await changeCapacityFixture(
        fixture,
        "UPDATE knowledge.kb_quotas SET owner_state = 'frozen' WHERE owner_id = $1",
      )
      await expect(client.authorizeUpload(target, declaration)).rejects.toMatchObject({
        problem: { code: 'FORBIDDEN' },
      })
    },
    true,
    {
      ...ossUploadEnvironment,
      KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    },
  )
})

it('refuses an unconfigured signer before creating an upload operation or entering a transaction', async () => {
  await withUploadHttpFixture(async (_fixture, { client, pool }) => {
    const connect = vi.spyOn(pool, 'connect')
    await expect(
      client.authorizeUpload(
        { spaceId: randomUUID(), documentId: randomUUID() },
        {
          operationId: randomUUID(),
          idempotencyKey: randomUUID(),
          expectedGeneration: '0',
          declaredBytes: '4',
          format: 'txt',
        },
      ),
    ).rejects.toMatchObject({ problem: { code: 'NOT_CONFIGURED' } })
    expect(connect).not.toHaveBeenCalled()
    connect.mockRestore()
  })
})
