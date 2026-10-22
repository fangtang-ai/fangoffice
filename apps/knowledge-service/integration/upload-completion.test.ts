import { expect, it } from 'vitest'
import * as runtime from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { withUploadCompletion } from './upload-completion-fixtures'

it('commits verified Version, capacity reservation and a real reference-only queue job together', async () => {
  await withUploadCompletion(async (fixture) => {
    const result = await capacityTransaction(fixture, (transaction) =>
      runtime.completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    expect(result).toMatchObject({
      replayed: false,
      operationId: fixture.input.prepared.operation.id,
      versionId: expect.any(String),
      jobId: expect.any(String),
    })
    await capacityTransaction(fixture, async (transaction) => {
      const facts = await transaction.query(
        `SELECT o.phase,o.target_version_id::text AS version_id,
        o.upload_job_id::text AS job_id,o.upload_queue_name AS queue_name,v.oss_key,v.size_bytes::text AS bytes,
        d.active_version_id,d.desired_version_id::text AS desired_version_id,r.state,
        q.reserved_files::text AS reserved_files,q.reserved_bytes::text AS reserved_bytes
        FROM knowledge.kb_operations o JOIN knowledge.kb_documents d ON d.owner_id=o.owner_id AND d.id=o.document_id
        JOIN knowledge.kb_versions v ON v.owner_id=o.owner_id AND v.document_id=o.document_id AND v.id=o.target_version_id
        JOIN knowledge.kb_reservations r ON r.owner_id=o.owner_id AND r.operation_id=o.id
        JOIN knowledge.kb_quotas q ON q.owner_id=o.owner_id WHERE o.id=$1`,
        [result.operationId],
      )
      expect(facts.rows).toEqual([
        {
          phase: 'queued',
          version_id: result.versionId,
          job_id: result.jobId,
          queue_name: fixture.policy.queueName,
          oss_key: fixture.input.stored.key,
          bytes: '4',
          active_version_id: null,
          desired_version_id: result.versionId,
          state: 'held',
          reserved_files: '1',
          reserved_bytes: '4',
        },
      ])
      const jobs = await transaction.query(
        'SELECT data FROM pgboss.job_common WHERE name=$1 AND id=$2',
        [fixture.policy.queueName, result.jobId],
      )
      expect(jobs.rows).toEqual([
        {
          data: {
            ownerId: fixture.owners[0],
            operationId: result.operationId,
            buildId: expect.any(String),
            receiptId: expect.any(String),
          },
        },
      ])
      expect(
        (
          await transaction.query(
            "SELECT id FROM knowledge.kb_billing_receipts WHERE id IN (SELECT (data->>'receiptId')::uuid FROM pgboss.job_common WHERE name=$1)",
            [fixture.policy.queueName],
          )
        ).rows,
      ).toEqual([])
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_builds WHERE operation_id=$1', [
            result.operationId,
          ])
        ).rows,
      ).toEqual([])
    })
  })
})
