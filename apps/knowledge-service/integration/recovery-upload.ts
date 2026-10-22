import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  createKnowledgeReplayPrincipal,
  prepareKnowledgeUpload,
  withKnowledgeTransaction,
} from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { removeTenants, seedTenants } from './tenant-fixtures'
import { uploadPolicy, uploadRequest } from './upload-fixtures'

export async function prepareUploadRecovery() {
  const seeded = await seedTenants('upload-recovery')
  const fixture = { ...seeded, expiresAt: new Date().toISOString() }
  try {
    const { pool } = await openLocalDatabase('bootstrap')
    try {
      await pool.query(
        `UPDATE knowledge.kb_quotas SET policy_revision = 'synthetic',
        limit_files = 1,limit_bytes = 4,limit_chunks = 1 WHERE owner_id = $1`,
        [fixture.owners[0]],
      )
    } finally {
      await pool.end()
    }
    const request = uploadRequest(fixture)
    const prepared = await capacityTransaction(fixture, (transaction) =>
      prepareKnowledgeUpload(transaction, request, uploadPolicy),
    )
    return { fixture, request, prepared }
  } catch (error) {
    await removeTenants(fixture)
    throw error
  }
}

export async function verifyRestoredUpload(
  recovery: Awaited<ReturnType<typeof prepareUploadRecovery>>,
) {
  const { pool } = await openLocalDatabase('api', 'restore')
  const principal = createKnowledgeReplayPrincipal(recovery.fixture.owners[0], {
    issuer: 'https://synthetic.invalid',
    audience: 'local-knowledge',
  })
  try {
    const replay = await withKnowledgeTransaction(pool, principal, (transaction) =>
      prepareKnowledgeUpload(
        transaction,
        { ...recovery.request, operationId: randomUUID() },
        uploadPolicy,
      ),
    )
    expect(replay).toEqual({ ...recovery.prepared, replayed: true })
  } finally {
    await pool.end()
  }
}
