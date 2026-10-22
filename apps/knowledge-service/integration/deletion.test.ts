import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { publishBuild } from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { publicationTransaction, withPublicationFixture } from './publication-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it('tombstones a published document and stops logical storage without forgiving physical debt', async () => {
  await withPublicationFixture(async (fixture) => {
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context))
    await capacityTransaction(fixture, async (transaction) => {
      const result = await transaction.query(
        "SELECT knowledge.apply_deletion_intent($1, 'document', $2, $3) AS status",
        [randomUUID(), fixture.id, fixture.id],
      )
      expect(result.rows).toEqual([{ status: 'DELETED' }])
    })
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect((await client.query(`SELECT active_files::text AS files, active_bytes::text AS bytes,
        active_chunks::text AS chunks, physical_accounted_bytes::text AS physical
        FROM knowledge.kb_quotas WHERE owner_id = $1`, [fixture.owners[0]])).rows)
        .toEqual([{ files: '0', bytes: '0', chunks: '0', physical: '16' }])
      expect((await client.query(`SELECT deleted_at IS NOT NULL AS deleted,
        active_build_id AS active, desired_operation_id AS desired, generation::text AS generation
        FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2`, [fixture.owners[0], fixture.id])).rows)
        .toEqual([{ deleted: true, active: null, desired: null, generation: '2' }])
      expect((await client.query(`SELECT active_bytes_before::text AS before, active_bytes_after::text AS after
        FROM knowledge.kb_metering_events WHERE owner_id = $1 ORDER BY sequence`, [fixture.owners[0]])).rows)
        .toEqual([{ before: '0', after: '4' }, { before: '4', after: '0' }])
    })
    // 普通角色不能清除删除事实：复活更新被门禁拒绝，墓碑保持。
    await expect(inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await client.query(`UPDATE knowledge.kb_documents SET deleted_at = NULL
        WHERE owner_id = $1 AND id = $2`, [fixture.owners[0], fixture.id])
    })).rejects.toThrow()
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect((await client.query(`SELECT deleted_at IS NOT NULL AS deleted,
        active_build_id AS active, generation::text AS generation
        FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2`, [fixture.owners[0], fixture.id])).rows)
        .toEqual([{ deleted: true, active: null, generation: '2' }])
    })
  })
})
