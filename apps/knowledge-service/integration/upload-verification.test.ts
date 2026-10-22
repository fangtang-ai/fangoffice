import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { prepareKnowledgeUpload, verifyKnowledgeTextUpload } from '../src/runtime'
import { ossUploadEnvironment } from '../tests/oss-upload-fixtures'
import { capacityTransaction } from './capacity-fixtures'
import { syntheticOssFormTarget } from './oss-form-fixtures'
import { uploadMetadata, uploadPolicy } from './upload-fixtures'
import { withUploadHttpFixture } from './upload-http-fixtures'

it('verifies the real HTTP object stream after account-bound upload without creating a Version or ready result', async () => {
  await withUploadHttpFixture(
    async (fixture, { client, service }) => {
      const target = { spaceId: randomUUID(), documentId: randomUUID() }
      const declaration = {
        operationId: randomUUID(),
        idempotencyKey: randomUUID(),
        expectedGeneration: '0',
        declaredBytes: '4',
        format: 'txt' as const,
      }
      await client.createSpace({ spaceId: target.spaceId }, { title: 'Synthetic verification' })
      await client.createDocument(target, uploadMetadata)
      const storage = await syntheticOssFormTarget(service.origin)
      try {
        const transfer = await client.uploadFile(target, declaration, new Blob(['test']))
        const prepared = await capacityTransaction(fixture, (transaction) =>
          prepareKnowledgeUpload(
            transaction,
            { ...declaration, target, expectedGeneration: 0n, declaredBytes: 4n },
            uploadPolicy,
          ),
        )
        expect(prepared.operation.id).toBe(transfer.operation.id)
        const object = await storage.readObject(prepared.staging.key)
        const verification = await verifyKnowledgeTextUpload(
          {
            prepared,
            sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            object,
          },
          { ...uploadPolicy, timeoutMs: 1000 },
        )
        expect(verification).toMatchObject({
          status: 'verified_staging',
          sourceBytes: '4',
          mimeType: 'text/plain',
          key: prepared.staging.key,
        })
        expect(object.body.destroyed).toBe(true)
        storage.objects.set(prepared.staging.key, Buffer.from('evil'))
        await expect(
          verifyKnowledgeTextUpload(
            {
              prepared,
              sourceHash: verification.sourceHash,
              object: await storage.readObject(prepared.staging.key),
            },
            { ...uploadPolicy, timeoutMs: 1000 },
          ),
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
        const state = await capacityTransaction(fixture, (transaction) =>
          transaction.query(
            `SELECT phase, target_version_id,
               (SELECT count(*)::text FROM knowledge.kb_versions WHERE document_id = $1) AS versions
             FROM knowledge.kb_operations WHERE id = $2`,
            [target.documentId, prepared.operation.id],
          ),
        )
        expect(state.rows).toEqual([{ phase: 'uploading', target_version_id: null, versions: '0' }])
        expect(storage.accountHeaders).toEqual([''])
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
