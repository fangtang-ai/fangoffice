import { createHash, randomUUID } from 'node:crypto'
import { PgBoss } from 'pg-boss'
import { createKnowledgeOssSourceStore, parseKnowledgeOssUploadConfig, type KnowledgeSourceStore } from '../src/runtime'
import { sourceHttpFixture } from '../tests/upload-source-http-fixtures'
import { ossUploadEnvironment } from '../tests/oss-upload-fixtures'
import { openLocalDatabase } from './local-database'
import { withUploadHttpFixture } from './upload-http-fixtures'
import { uploadMetadata } from './upload-fixtures'

export async function withCompletionHttpFixture(
  work: (fixture: Parameters<Parameters<typeof withUploadHttpFixture>[0]>[0], api: Parameters<Parameters<typeof withUploadHttpFixture>[0]>[1], objects: Awaited<ReturnType<typeof sourceHttpFixture>>, queueName: string) => Promise<void>,
  overrides: Record<string, string> = {},
  source?: (store: KnowledgeSourceStore) => KnowledgeSourceStore,
) {
  const storage = await sourceHttpFixture()
  const { pool } = await openLocalDatabase('migrator')
  const boss = new PgBoss({ schema: 'pgboss', db: { executeSql: (statement, values) => pool.query(statement, values) }, createSchema: false, migrate: false, supervise: false, schedule: false })
  boss.on('error', () => {})
  const queueName = `http_${randomUUID().replaceAll('-', '')}`
  try {
    await boss.createQueue(queueName)
    const config = { ...ossUploadEnvironment,
      KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
      KNOWLEDGE_UPLOAD_COMPLETION_QUEUE: queueName,
      KNOWLEDGE_UPLOAD_RESERVATION_CHUNKS: '1',
      KNOWLEDGE_UPLOAD_RESERVATION_PHYSICAL_BYTES: '64',
      ...overrides,
    }
    const store = createKnowledgeOssSourceStore(parseKnowledgeOssUploadConfig(config)!, { fetch: storage.fetch })
    await withUploadHttpFixture((fixture, api) => work(fixture, api, storage, queueName), true, config, { uploadSource: source ? source(store) : store })
  } finally {
    try { await boss.deleteQueue(queueName) }
    finally { await pool.end(); await storage.close() }
  }
}

export async function prepareHttpCompletion(
  fixture: Parameters<Parameters<typeof withUploadHttpFixture>[0]>[0],
  api: Parameters<Parameters<typeof withUploadHttpFixture>[0]>[1],
  storage: Awaited<ReturnType<typeof sourceHttpFixture>>,
) {
  const target = { spaceId: fixture.id, documentId: fixture.otherDocumentId }
  const request = { operationId: randomUUID(), idempotencyKey: randomUUID(), expectedGeneration: '0', declaredBytes: '4', format: 'txt', sourceHash: createHash('sha256').update('test').digest('hex') }
  await api.client.createDocument(target, { ...uploadMetadata, title: 'Other document', tags: [] })
  const { sourceHash, ...declaration } = request
  const prepared = await api.client.prepareUpload(target, declaration)
  const key = `staging/${createHash('sha256').update(fixture.owners[0]).digest('hex')}/${prepared.operation.id}`
  storage.objects.set(key, { bytes: Buffer.from('test'), etag: '"staging-http"', mimeType: 'application/octet-stream' })
  return { target, request: { ...request, sourceHash }, key, prepared, path: `/api/knowledge/spaces/${target.spaceId}/documents/${target.documentId}/uploads/completion` }
}
