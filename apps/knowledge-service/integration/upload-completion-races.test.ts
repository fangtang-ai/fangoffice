import { expect, it } from 'vitest'
import { completeKnowledgeUpload } from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { prepareCompletionFixture } from './upload-completion-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes duplicate completion behind a real %s wait',
  async (outcome) => {
    await withCapacityRace(async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      const prepared = await prepareCompletionFixture(fixture)
      try {
        const first = await completeKnowledgeUpload(writer, prepared.input, prepared.policy)
        const pending = completeKnowledgeUpload(waiter, prepared.input, prepared.policy)
        await expectBlocked(observer, waiterPid, writerPid)
        await writer.query(outcome)
        const result = await pending
        expect(result.replayed).toBe(outcome === 'COMMIT')
        if (outcome === 'COMMIT') expect(result).toEqual({ ...first, replayed: true })
        await waiter.query('COMMIT')
        expect(
          (
            await observer.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
              prepared.policy.queueName,
            ])
          ).rows,
        ).toEqual([{ id: result.jobId }])
      } finally {
        await Promise.allSettled([writer.query('ROLLBACK'), waiter.query('ROLLBACK')])
        await prepared.close()
      }
    })
  },
)

it.each(['expiry', 'freeze'] as const)(
  'rechecks committed %s after waiting on the owner lock',
  async (gate) => {
    await withCapacityRace(
      async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
        const prepared = await prepareCompletionFixture(fixture)
        try {
          await writer.query(
            'SELECT owner_id FROM knowledge.kb_quotas WHERE owner_id=$1 FOR UPDATE',
            [fixture.owners[0]],
          )
          const pending = expect(
            completeKnowledgeUpload(waiter, prepared.input, prepared.policy),
          ).rejects.toMatchObject({ code: gate === 'expiry' ? 'VERSION_CONFLICT' : 'FORBIDDEN' })
          await expectBlocked(observer, waiterPid, writerPid)
          if (gate === 'expiry')
            await writer.query(
              "UPDATE knowledge.kb_operations SET upload_expires_at=clock_timestamp()-interval '1s' WHERE owner_id=$1 AND id=$2",
              [fixture.owners[0], prepared.input.prepared.operation.id],
            )
          else
            await writer.query(
              "UPDATE knowledge.kb_quotas SET owner_state='frozen' WHERE owner_id=$1",
              [fixture.owners[0]],
            )
          await writer.query('COMMIT')
          await pending
          await waiter.query('ROLLBACK')
          expect(
            (
              await observer.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
                prepared.policy.queueName,
              ])
            ).rows,
          ).toEqual([])
        } finally {
          await Promise.allSettled([writer.query('ROLLBACK'), waiter.query('ROLLBACK')])
          await prepared.close()
        }
      },
      'api',
      'bootstrap',
    )
  },
)
