import { expect } from 'vitest'
import {
  completeKnowledgeUpload,
  createKnowledgeReplayPrincipal,
  withKnowledgeTransaction,
} from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { removeTenants, seedTenants } from './tenant-fixtures'
import { prepareCompletionFixture } from './upload-completion-fixtures'

export async function prepareUploadCompletionRecovery() {
  const seeded = await seedTenants('upload-completion-recovery')
  const base = { ...seeded, expiresAt: new Date(Date.now() + 3600000).toISOString() }
  let fixture: Awaited<ReturnType<typeof prepareCompletionFixture>> | undefined
  try {
    const { pool } = await openLocalDatabase('bootstrap')
    try {
      await pool.query(
        `UPDATE knowledge.kb_quotas SET policy_revision='synthetic',
        limit_files=1,limit_bytes=4,limit_chunks=1 WHERE owner_id=$1`,
        [base.owners[0]],
      )
    } finally {
      await pool.end()
    }
    fixture = await prepareCompletionFixture(base)
    const prepared = fixture
    const result = await capacityTransaction(base, (transaction) =>
      completeKnowledgeUpload(transaction, prepared.input, prepared.policy),
    )
    return { ...fixture, result }
  } catch (error) {
    try {
      await fixture?.close()
    } finally {
      await removeTenants(base)
    }
    throw error
  }
}

export async function verifyRestoredUploadCompletion(
  recovery: Awaited<ReturnType<typeof prepareUploadCompletionRecovery>>,
) {
  const { pool } = await openLocalDatabase('api', 'restore')
  const principal = createKnowledgeReplayPrincipal(recovery.owners[0], {
    issuer: 'https://synthetic.invalid',
    audience: 'local-knowledge',
  })
  try {
    await withKnowledgeTransaction(pool, principal, async (transaction) => {
      const replay = await completeKnowledgeUpload(transaction, recovery.input, recovery.policy)
      expect(replay).toEqual({ ...recovery.result, replayed: true })
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
            recovery.otherDocumentId,
          ])
        ).rows,
      ).toEqual([{ id: recovery.result.versionId }])
      expect(
        (
          await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
            recovery.policy.queueName,
          ])
        ).rows,
      ).toEqual([{ id: recovery.result.jobId }])
      expect(
        (
          await transaction.query(
            'SELECT reserved_files::text AS files,reserved_bytes::text AS bytes FROM knowledge.kb_quotas',
          )
        ).rows,
      ).toEqual([{ files: '1', bytes: '4' }])
    })
  } finally {
    await pool.end()
  }
}
