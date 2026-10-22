import { expect, it } from 'vitest'
import { completeKnowledgeUpload } from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { withUploadCompletion } from './upload-completion-fixtures'

it('does not commit an orphan job when the caller handles a completion refusal', async () => {
  await withUploadCompletion(async (fixture) => {
    await capacityTransaction(fixture, async (transaction) => {
      await expect(
        completeKnowledgeUpload(
          transaction,
          {
            ...fixture.input,
            capacity: { ...fixture.input.capacity, chunks: 2n },
          },
          fixture.policy,
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })
    const jobs = await capacityTransaction(fixture, (transaction) =>
      transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
        fixture.policy.queueName,
      ]),
    )
    expect(jobs.rows).toEqual([])
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query(
            'SELECT phase,target_version_id FROM knowledge.kb_operations WHERE id=$1',
            [fixture.input.prepared.operation.id],
          )
        ).rows,
      ).toEqual([{ phase: 'uploading', target_version_id: null }])
      expect(
        (
          await transaction.query(
            'SELECT reserved_files::text AS files,reserved_bytes::text AS bytes FROM knowledge.kb_quotas',
          )
        ).rows,
      ).toEqual([{ files: '0', bytes: '0' }])
    })
  })
})

it('can retry a handled refusal in the same transaction without retaining its failed job', async () => {
  await withUploadCompletion(async (fixture) => {
    const completed = await capacityTransaction(fixture, async (transaction) => {
      await expect(
        completeKnowledgeUpload(
          transaction,
          {
            ...fixture.input,
            capacity: { ...fixture.input.capacity, chunks: 2n },
          },
          fixture.policy,
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
      return completeKnowledgeUpload(transaction, fixture.input, fixture.policy)
    })
    expect(completed.replayed).toBe(false)
    const facts = await capacityTransaction(fixture, async (transaction) => ({
      jobs: (
        await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
          fixture.policy.queueName,
        ])
      ).rows,
      versions: (
        await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
          fixture.otherDocumentId,
        ])
      ).rows,
      quota: (
        await transaction.query(
          'SELECT reserved_files::text AS files,reserved_bytes::text AS bytes FROM knowledge.kb_quotas',
        )
      ).rows,
    }))
    expect(facts).toEqual({
      jobs: [{ id: completed.jobId }],
      versions: [{ id: completed.versionId }],
      quota: [{ files: '1', bytes: '4' }],
    })
  })
})
