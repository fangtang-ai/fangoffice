import { expect, it } from 'vitest'
import {
  cancelCapacityReservation,
  claimBuild,
  completeKnowledgeUpload,
  createKnowledgeQueue,
  parseQueueEnvelope,
} from '../src/runtime'
import { capacityTransaction, changeCapacityFixture } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { withUploadCompletion } from './upload-completion-fixtures'

it('replays an identical completion without another Version, reservation or queue job', async () => {
  await withUploadCompletion(async (fixture) => {
    const first = await capacityTransaction(fixture, (transaction) =>
      completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    const again = await capacityTransaction(fixture, (transaction) =>
      completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    expect(again).toEqual({ ...first, replayed: true })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
            fixture.otherDocumentId,
          ])
        ).rows,
      ).toEqual([{ id: first.versionId }])
      expect(
        (
          await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
            fixture.policy.queueName,
          ])
        ).rows,
      ).toEqual([{ id: first.jobId }])
      expect(
        (await transaction.query('SELECT reserved_bytes::text AS bytes FROM knowledge.kb_quotas'))
          .rows,
      ).toEqual([{ bytes: '4' }])
    })
  })
})

it('rolls back Version, pointers, all capacity and the queued job when the caller transaction aborts', async () => {
  await withUploadCompletion(async (fixture) => {
    await expect(
      capacityTransaction(fixture, async (transaction) => {
        await completeKnowledgeUpload(transaction, fixture.input, fixture.policy)
        throw new Error('synthetic-transaction-abort')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query(
            'SELECT phase,target_version_id,upload_job_id FROM knowledge.kb_operations WHERE id=$1',
            [fixture.input.prepared.operation.id],
          )
        ).rows,
      ).toEqual([{ phase: 'uploading', target_version_id: null, upload_job_id: null }])
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
            fixture.otherDocumentId,
          ])
        ).rows,
      ).toEqual([])
      expect(
        (await transaction.query('SELECT operation_id FROM knowledge.kb_reservations')).rows,
      ).toEqual([])
      expect(
        (
          await transaction.query(
            'SELECT reserved_files::text AS files,reserved_bytes::text AS bytes,physical_reserved_bytes::text AS physical FROM knowledge.kb_quotas',
          )
        ).rows,
      ).toEqual([{ files: '0', bytes: '0', physical: '0' }])
      expect(
        (
          await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
            fixture.policy.queueName,
          ])
        ).rows,
      ).toEqual([])
    })
  })
})

it('replays committed completion after queue retention removes the original job', async () => {
  await withUploadCompletion(async (fixture) => {
    const first = await capacityTransaction(fixture, (transaction) =>
      completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    const { pool } = await openLocalDatabase('bootstrap')
    try {
      const removed = await pool.query('DELETE FROM pgboss.job_common WHERE name=$1 AND id=$2', [
        fixture.policy.queueName,
        first.jobId,
      ])
      expect(removed.rowCount).toBe(1)
    } finally {
      await pool.end()
    }
    const replay = await capacityTransaction(fixture, (transaction) =>
      completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    expect(replay).toEqual({ ...first, replayed: true })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
            fixture.policy.queueName,
          ])
        ).rows,
      ).toEqual([])
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
            fixture.otherDocumentId,
          ])
        ).rows,
      ).toEqual([{ id: first.versionId }])
      expect(
        (
          await transaction.query(
            'SELECT reserved_files::text AS files,reserved_bytes::text AS bytes FROM knowledge.kb_quotas',
          )
        ).rows,
      ).toEqual([{ files: '1', bytes: '4' }])
    })
  })
})

it('replays a committed acknowledgment after the upload session expires without creating a new job', async () => {
  await withUploadCompletion(async (fixture) => {
    const first = await capacityTransaction(fixture, (transaction) =>
      completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    await changeCapacityFixture(
      fixture,
      "UPDATE knowledge.kb_operations SET upload_expires_at=clock_timestamp()-interval '1s' WHERE owner_id=$1 AND id=$2",
      [fixture.input.prepared.operation.id],
    )
    expect(
      await capacityTransaction(fixture, (transaction) =>
        completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
      ),
    ).toEqual({ ...first, replayed: true })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
            fixture.policy.queueName,
          ])
        ).rows,
      ).toEqual([{ id: first.jobId }])
    })
  })
})

it.each(['chunks', 'physical'] as const)(
  'rolls back send when final %s capacity admission fails',
  async (dimension) => {
    await withUploadCompletion(async (fixture) => {
      if (dimension === 'physical')
        await changeCapacityFixture(
          fixture,
          'UPDATE knowledge.kb_quotas SET physical_limit_bytes=19 WHERE owner_id=$1',
        )
      const input =
        dimension === 'chunks'
          ? { ...fixture.input, capacity: { ...fixture.input.capacity, chunks: 2n } }
          : fixture.input
      await expect(
        capacityTransaction(fixture, (transaction) =>
          completeKnowledgeUpload(transaction, input, fixture.policy),
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
      await capacityTransaction(fixture, async (transaction) => {
        expect(
          (
            await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
              fixture.policy.queueName,
            ])
          ).rows,
        ).toEqual([])
        expect(
          (
            await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
              fixture.otherDocumentId,
            ])
          ).rows,
        ).toEqual([])
      })
    })
  },
)

it('refuses a missing queue without creating a partial Version or reservation', async () => {
  await withUploadCompletion(async (fixture) => {
    await expect(
      capacityTransaction(fixture, (transaction) =>
        completeKnowledgeUpload(transaction, fixture.input, {
          ...fixture.policy,
          queueName: 'synthetic_missing_upload_queue',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
            fixture.otherDocumentId,
          ])
        ).rows,
      ).toEqual([])
      expect(
        (await transaction.query('SELECT operation_id FROM knowledge.kb_reservations')).rows,
      ).toEqual([])
    })
  })
})

it.each(['hash', 'bucket', 'chunks', 'expiry', 'queue'] as const)(
  'rejects changed %s on completion replay',
  async (field) => {
    await withUploadCompletion(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
      )
      const stored =
        field === 'hash'
          ? { ...fixture.input.stored, sourceHash: 'b'.repeat(64) }
          : fixture.input.stored
      const capacity = {
        ...fixture.input.capacity,
        ...(field === 'chunks' ? { chunks: 0n } : {}),
        ...(field === 'expiry'
          ? { expiresAt: new Date(fixture.input.capacity.expiresAt.getTime() + 1000) }
          : {}),
      }
      const policy = {
        ...fixture.policy,
        ...(field === 'bucket' ? { bucket: 'other-private-bucket' } : {}),
        ...(field === 'queue' ? { queueName: 'other_upload_queue' } : {}),
      }
      await expect(
        capacityTransaction(fixture, (transaction) =>
          completeKnowledgeUpload(transaction, { ...fixture.input, stored, capacity }, policy),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      await capacityTransaction(fixture, async (transaction) => {
        expect(
          (
            await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
              fixture.policy.queueName,
            ])
          ).rows,
        ).toHaveLength(1)
      })
    })
  },
)

it('does not fabricate the receipt needed to claim the queued build', async () => {
  await withUploadCompletion(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    const { pool } = await openLocalDatabase('worker')
    try {
      const job = await createKnowledgeQueue(pool, fixture.policy.queueName).fetch()
      expect(job).not.toBeNull()
      if (!job) throw new Error('Expected real queued upload')
      const envelope = parseQueueEnvelope(job.data)
      await expect(
        capacityTransaction(
          fixture,
          (transaction) =>
            claimBuild(transaction, job, envelope, {
              indexProfileId: fixture.profileId,
              parserRevision: 'synthetic',
              parserSnapshot: {},
            }),
          fixture.owners[0],
          'worker',
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await capacityTransaction(fixture, async (transaction) => {
        expect(
          (
            await transaction.query('SELECT id FROM knowledge.kb_builds WHERE operation_id=$1', [
              fixture.input.prepared.operation.id,
            ])
          ).rows,
        ).toEqual([])
        expect(
          (
            await transaction.query('SELECT id FROM knowledge.kb_billing_receipts WHERE id=$1', [
              envelope.receiptId,
            ])
          ).rows,
        ).toEqual([])
      })
    } finally {
      await pool.end()
    }
  })
})

it('rejects a stale completion after real cancellation advances the document generation', async () => {
  await withUploadCompletion(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
    )
    await capacityTransaction(fixture, (transaction) =>
      cancelCapacityReservation(transaction, fixture.input.prepared.operation.id),
    )
    await expect(
      capacityTransaction(fixture, (transaction) =>
        completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query(
            'SELECT generation::text AS generation,desired_version_id,active_version_id FROM knowledge.kb_documents WHERE id=$1',
            [fixture.otherDocumentId],
          )
        ).rows,
      ).toEqual([{ generation: '1', desired_version_id: null, active_version_id: null }])
      expect(
        (
          await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
            fixture.policy.queueName,
          ])
        ).rows,
      ).toHaveLength(1)
    })
  })
})
