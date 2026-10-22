import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createKnowledgeDocument, prepareKnowledgeUpload } from '../src/runtime'
import {
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'
import { uploadMetadata, uploadPolicy, uploadRequest } from './upload-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it.each(['files', 'bytes', 'physical', 'fileLimit'] as const)(
  'refuses upload beyond the %s bound',
  async (limit) => {
    await withCapacityFixture(async (fixture) => {
      if (limit === 'files')
        await changeCapacityFixture(
          fixture,
          'UPDATE knowledge.kb_quotas SET limit_files = 0 WHERE owner_id = $1',
        )
      if (limit === 'bytes')
        await changeCapacityFixture(
          fixture,
          'UPDATE knowledge.kb_quotas SET limit_bytes = 3 WHERE owner_id = $1',
        )
      if (limit === 'physical')
        await changeCapacityFixture(
          fixture,
          'UPDATE knowledge.kb_quotas SET physical_limit_bytes = 3 WHERE owner_id = $1',
        )
      await expect(
        capacityTransaction(fixture, (transaction) =>
          prepareKnowledgeUpload(transaction, uploadRequest(fixture), {
            maximumFileBytes: limit === 'fileLimit' ? 3n : 16n,
          }),
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
      await capacityTransaction(fixture, async (transaction) => {
        expect(
          (
            await transaction.query(
              'SELECT desired_operation_id FROM knowledge.kb_documents WHERE id = $1',
              [fixture.otherDocumentId],
            )
          ).rows,
        ).toEqual([{ desired_operation_id: null }])
      })
    })
  },
)

it.each(['cancelled', 'failed'] as const)(
  'does not forgive staging debt when an operation is %s',
  async (phase) => {
    await withCapacityFixture(async (fixture) => {
      const request = uploadRequest(fixture)
      await capacityTransaction(fixture, (transaction) =>
        prepareKnowledgeUpload(transaction, request, uploadPolicy),
      )
      await changeCapacityFixture(
        fixture,
        'UPDATE knowledge.kb_operations SET phase = $3, error_code = $4 WHERE owner_id = $1 AND id = $2',
        [request.operationId, phase, phase === 'failed' ? 'synthetic-failure' : null],
      )
      await changeCapacityFixture(
        fixture,
        'UPDATE knowledge.kb_quotas SET physical_limit_bytes = 6 WHERE owner_id = $1',
      )
      const target = { spaceId: fixture.id, documentId: randomUUID() }
      await capacityTransaction(fixture, (transaction) =>
        createKnowledgeDocument(transaction, target, uploadMetadata),
      )
      await expect(
        capacityTransaction(fixture, (transaction) =>
          prepareKnowledgeUpload(transaction, { ...uploadRequest(fixture), target }, uploadPolicy),
        ),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
      await expect(
        capacityTransaction(fixture, (transaction) =>
          prepareKnowledgeUpload(transaction, request, uploadPolicy),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    })
  },
)

it.each(['expired', 'deleted', 'frozen', 'spaceFrozen'] as const)(
  'does not issue a session for %s state',
  async (state) => {
    await withCapacityFixture(async (fixture) => {
      const request = uploadRequest(fixture)
      if (state === 'deleted')
        await inRoleTransaction('bootstrap', undefined, async (client) => {
          // 通用种子含与零active容量不一致的演示事件；只清理本合成owner，不用坏账反例代替墓碑门禁。
          await client.query(
            'ALTER TABLE knowledge.kb_metering_events DISABLE TRIGGER kb_immutable_facts',
          )
          await client.query('DELETE FROM knowledge.kb_metering_events WHERE owner_id = $1', [
            fixture.owners[0],
          ])
          await client.query(
            'ALTER TABLE knowledge.kb_metering_events ENABLE TRIGGER kb_immutable_facts',
          )
          await client.query('COMMIT')
        })
      await capacityTransaction(fixture, (transaction) =>
        prepareKnowledgeUpload(transaction, request, uploadPolicy),
      )
      if (state === 'expired')
        await changeCapacityFixture(
          fixture,
          "UPDATE knowledge.kb_operations SET upload_expires_at = now() - interval '1 second' WHERE owner_id = $1 AND id = $2",
          [request.operationId],
        )
      if (state === 'deleted')
        await capacityTransaction(fixture, async (transaction) => {
          expect(
            (
              await transaction.query(
                "SELECT knowledge.apply_deletion_intent($1,'document',$2,$3) AS status",
                [randomUUID(), fixture.id, fixture.otherDocumentId],
              )
            ).rows,
          ).toEqual([{ status: 'DELETED' }])
        })
      if (state === 'frozen')
        await changeCapacityFixture(
          fixture,
          "UPDATE knowledge.kb_quotas SET owner_state = 'frozen' WHERE owner_id = $1",
        )
      if (state === 'spaceFrozen')
        await changeCapacityFixture(
          fixture,
          "UPDATE knowledge.kb_spaces SET state = 'frozen' WHERE owner_id = $1 AND id = $2",
          [fixture.id],
        )
      await expect(
        capacityTransaction(fixture, (transaction) =>
          prepareKnowledgeUpload(transaction, request, uploadPolicy),
        ),
      ).rejects.toMatchObject({ code: state === 'expired' ? 'VERSION_CONFLICT' : 'FORBIDDEN' })
    })
  },
)
