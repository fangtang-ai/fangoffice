import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { publishBuild } from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { publicationTransaction, withPublicationFixture } from './publication-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

// 冻结语义：墓碑后的文档对每一条变更路径都冻结——
// 准入/替换/重试/取消（代数栅栏或删除门拒绝）、失败/换绑/绑定（worker角色拒绝）、
// 发布/worker认领（触发器拒绝）、过期扫描（跳过）全部挡住，
// 零复活、零账动、零新删除事实；重放仍REPLAY。
it('freezes a tombstoned document against every mutation path', async () => {
  await withPublicationFixture(async (fixture) => {
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context))
    const intent = randomUUID()
    await capacityTransaction(fixture, async (transaction) => {
      expect((await transaction.query(
        "SELECT knowledge.apply_deletion_intent($1, 'document', $2, $3) AS status",
        [intent, fixture.id, fixture.id],
      )).rows).toEqual([{ status: 'DELETED' }])
    })
    // 维护主体：准入家族全部拒绝；initial 先撞墓碑推代后的代数栅栏。
    await capacityTransaction(fixture, async (transaction) => {
      const status = async (sql: string, args: unknown[]) =>
        ((await transaction.query(sql, args)).rows[0] as { status?: string } | undefined)?.status
      expect(await status(
        "SELECT knowledge.reserve_initial_capacity($1, 1, 16, now() + interval '1 hour') AS status", [fixture.id],
      )).toEqual('VERSION_CONFLICT')
      expect(await status(
        "SELECT knowledge.reserve_replacement_capacity($1, 1, 16, now() + interval '1 hour') AS status", [fixture.id],
      )).toEqual('FORBIDDEN')
      expect(await status(
        "SELECT knowledge.reserve_retry_capacity($1, 1, 16, now() + interval '1 hour') AS status", [fixture.id],
      )).toEqual('FORBIDDEN')
      expect(await status(
        'SELECT knowledge.cancel_capacity_reservation($1) AS status', [fixture.id],
      )).toEqual('FORBIDDEN')
    })
    // worker 授权的收敛入口同样拒绝冻结文档。
    await expect(inRoleTransaction('worker', fixture.owners[0], async (client) =>
      (await client.query('SELECT knowledge.fail_current_build_attempt($1, $2, $3, $4) AS status',
        [fixture.id, fixture.id, 0, 'freeze-probe'])).rows,
    )).resolves.toEqual([{ status: 'FORBIDDEN' }])
    await expect(inRoleTransaction('worker', fixture.owners[0], async (client) =>
      (await client.query('SELECT knowledge.rebind_operation_attempt($1, $2, $3, $4, $5, $6) AS status',
        [fixture.owners[0], fixture.id, fixture.id, fixture.id, 1, fixture.id])).rows,
    )).resolves.toEqual([{ status: 'FORBIDDEN' }])
    await expect(inRoleTransaction('worker', fixture.owners[0], async (client) =>
      (await client.query('SELECT knowledge.bind_operation_attempt($1, $2, $3, $4, $5, $6) AS status',
        [fixture.owners[0], fixture.id, fixture.id, fixture.id, 0, fixture.id])).rows,
    )).resolves.toEqual([{ status: 'FORBIDDEN' }])
    // 过期扫描跳过冻结文档，收敛计数为0。
    await expect(inRoleTransaction('worker', fixture.owners[0], async (client) =>
      (await client.query('SELECT knowledge.expire_owner_stale_operations() AS converged')).rows,
    )).resolves.toEqual([{ converged: 0 }])
    // 发布重放：墓碑后的重新发布命中已收敛判定（reservation applied+终态op+计量事件），
    // 返回幂等REPLAY且零状态变更——不复活、不重复计量。
    await expect(publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )).resolves.toEqual({ replayed: true })
    await expect(inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await client.query(
        `INSERT INTO knowledge.kb_builds
           (owner_id, id, document_id, version_id, operation_id, job_id, retry_count,
            expected_generation, index_profile_id, parser_revision, parser_snapshot)
         SELECT owner_id, $2::uuid, document_id, version_id, operation_id, $4::uuid, $3,
                expected_generation, index_profile_id, parser_revision, parser_snapshot
           FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $3`,
        [fixture.owners[0], randomUUID(), fixture.id, randomUUID()],
      )
    })).rejects.toThrow()
    // 幂等重放仍是REPLAY：上述全部尝试未产生新删除事实。
    await capacityTransaction(fixture, async (transaction) => {
      expect((await transaction.query(
        "SELECT knowledge.apply_deletion_intent($1, 'document', $2, $3) AS status",
        [intent, fixture.id, fixture.id],
      )).rows).toEqual([{ status: 'REPLAY' }])
    })
    // 冻结不变量：墓碑、代数、逻辑清零、物理负债、计量事件、终态行原样。
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      expect((await client.query(`SELECT deleted_at IS NOT NULL AS deleted,
        active_build_id AS active, desired_operation_id AS desired, generation::text AS generation
        FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2`, [fixture.owners[0], fixture.id])).rows)
        .toEqual([{ deleted: true, active: null, desired: null, generation: '2' }])
      expect((await client.query(`SELECT active_files::text AS files, active_bytes::text AS bytes,
        active_chunks::text AS chunks, physical_accounted_bytes::text AS physical
        FROM knowledge.kb_quotas WHERE owner_id = $1`, [fixture.owners[0]])).rows)
        .toEqual([{ files: '0', bytes: '0', chunks: '0', physical: '16' }])
      expect((await client.query(`SELECT count(*)::int AS events
        FROM knowledge.kb_metering_events WHERE owner_id = $1`, [fixture.owners[0]])).rows)
        .toEqual([{ events: 2 }])
      expect((await client.query(`SELECT kind, phase FROM knowledge.kb_operations
        WHERE owner_id = $1 AND document_id = $2 ORDER BY kind`, [fixture.owners[0], fixture.id])).rows)
        .toEqual([{ kind: 'delete', phase: 'deleted' }, { kind: 'upload', phase: 'ready' }])
      expect((await client.query(`SELECT gc_state, purged_at IS NOT NULL AS purged
        FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2`, [fixture.owners[0], fixture.id])).rows)
        .toEqual([{ gc_state: 'live', purged: false }])
    })
  })
})