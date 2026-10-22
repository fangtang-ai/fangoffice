import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { completeKnowledgeUpload, publishBuild } from '../src/runtime'
import { capacityTransaction, changeCapacityFixture } from './capacity-fixtures'
import { publicationTransaction, withPublicationFixture } from './publication-fixtures'
import { prepareCompletionFixture } from './upload-completion-fixtures'

it.each(['document', 'space'] as const)(
  'rejects first completion after a real %s deletion',
  async (scope) => {
    await withPublicationFixture(async (base) => {
      await publicationTransaction(base, (transaction) => publishBuild(transaction, base.context))
      await changeCapacityFixture(
        base,
        'UPDATE knowledge.kb_quotas SET limit_files=2,limit_bytes=8,limit_chunks=2 WHERE owner_id=$1',
      )
      const fixture = await prepareCompletionFixture(base)
      try {
        const deletion = await capacityTransaction(fixture, (transaction) =>
          transaction.query('SELECT knowledge.apply_deletion_intent($1,$2,$3,$4) AS status', [
            randomUUID(),
            scope,
            fixture.id,
            scope === 'document' ? fixture.otherDocumentId : null,
          ]),
        )
        expect(deletion.rows).toEqual([{ status: 'DELETED' }])
        await expect(
          capacityTransaction(fixture, (transaction) =>
            completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
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
        }))
        expect(facts).toEqual({ jobs: [], versions: [] })
      } finally {
        await fixture.close()
      }
    })
  },
)
