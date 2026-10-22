import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { PgBoss } from 'pg-boss'
import { prepareKnowledgeUpload, saveKnowledgeTextUpload } from '../src/runtime'
import { capacityTransaction, withCapacityFixture } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { uploadPolicy, uploadRequest } from './upload-fixtures'

export async function withUploadCompletion(
  work: (fixture: Awaited<ReturnType<typeof prepareCompletionFixture>>) => Promise<void>,
) {
  await withCapacityFixture(async (base) => {
    const fixture = await prepareCompletionFixture(base)
    try {
      await work(fixture)
    } finally {
      await fixture.close()
    }
  })
}

export async function prepareCompletionFixture(base: Parameters<typeof uploadRequest>[0]) {
  const { pool } = await openLocalDatabase('migrator')
  const boss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (statement, values) => pool.query(statement, values) },
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  boss.on('error', () => {})
  const queueName = `upload_${randomUUID().replaceAll('-', '')}`
  try {
    await boss.createQueue(queueName)
  } catch (error) {
    await pool.end()
    throw error
  }
  try {
    const request = uploadRequest(base)
    const prepared = await capacityTransaction(base, (transaction) =>
      prepareKnowledgeUpload(transaction, request, uploadPolicy),
    )
    const bytes = Buffer.from('test')
    const stored = await saveKnowledgeTextUpload(
      {
        prepared,
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        object: {
          key: prepared.staging.key,
          etag: '"synthetic-staging"',
          contentType: 'application/octet-stream',
          contentLength: 4n,
          body: Readable.from([bytes]),
        },
      },
      {
        async copy() {
          return 'copied'
        },
        async read({ key }) {
          return {
            key,
            etag: '"synthetic-original"',
            contentType: 'text/plain',
            contentLength: 4n,
            body: Readable.from([bytes]),
          }
        },
      },
      { maximumFileBytes: 16n, timeoutMs: 1000 },
    )
    return {
      ...base,
      input: {
        prepared,
        stored,
        capacity: { chunks: 1n, physicalBytes: 16n, expiresAt: new Date(base.expiresAt) },
      },
      policy: { bucket: 'synthetic-private-knowledge', queueName, maximumFileBytes: 16n },
      async close() {
        try {
          await boss.deleteQueue(queueName)
        } finally {
          await pool.end()
        }
      },
    }
  } catch (error) {
    try {
      await boss.deleteQueue(queueName)
    } finally {
      await pool.end()
    }
    throw error
  }
}
