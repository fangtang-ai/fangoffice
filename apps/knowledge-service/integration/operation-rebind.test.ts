import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { bindSeedBuild } from './build-fixtures'
import { claimBuild, type KnowledgeTransaction } from '../src/runtime'
import {
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
  type CapacityFixture,
} from './capacity-fixtures'
import { closedBuildStates, prepareContentInsert } from './build-fixtures'
import { roleNames } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

const signature = 'knowledge.rebind_operation_attempt(text,uuid,uuid,uuid,integer,uuid)'

const envelopeFor = (fixture: CapacityFixture, buildId: string) => ({
  ownerId: fixture.owners[0],
  operationId: fixture.id,
  buildId,
  receiptId: fixture.id,
})

// 在 worker 事务里认领同 job 的重试构建行（取消门重试分支放行）。
const claimRetryBuildRow = (
  transaction: KnowledgeTransaction,
  fixture: CapacityFixture,
  buildId: string,
  retryCount: number,
  jobId: string,
) =>
  transaction.query(
    `INSERT INTO knowledge.kb_builds
       (owner_id, id, document_id, version_id, operation_id, job_id, retry_count,
        expected_generation, index_profile_id, parser_revision, parser_snapshot)
     SELECT owner_id, $2::uuid, document_id, version_id, operation_id, $5::uuid, $4,
            expected_generation, index_profile_id, parser_revision, parser_snapshot
       FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $3`,
    [fixture.owners[0], buildId, fixture.id, retryCount, jobId],
  )

const rebindAsWorker = (
  fixture: CapacityFixture,
  buildId: string,
  jobId: string,
  retryCount: number,
) =>
  capacityTransaction(
    fixture,
    (transaction) =>
      transaction.query('SELECT knowledge.rebind_operation_attempt($1, $2, $3, $4, $5, $2) AS status', [
        fixture.owners[0],
        fixture.id,
        buildId,
        jobId,
        retryCount,
      ]),
    fixture.owners[0],
    'worker',
  )

const bindingFacts = (fixture: CapacityFixture) =>
  inRoleTransaction('api', fixture.owners[0], async (client) => {
    const { rows } = await client.query<{
      current_build: string | null
      current_job: string | null
      current_retry: string | null
      generation: string
    }>(
      `SELECT operation.current_build_id::text AS current_build,
              operation.current_job_id::text AS current_job,
              operation.current_retry_count::text AS current_retry,
              document.generation::text AS generation
         FROM knowledge.kb_operations operation
         JOIN knowledge.kb_documents document ON document.owner_id = operation.owner_id
           AND document.id = operation.document_id
        WHERE operation.owner_id = $1 AND operation.id = $2`,
      [fixture.owners[0], fixture.id],
    )
    if (!rows[0]) throw new Error('Missing rebind facts')
    return rows[0]
  })

it('keeps the rebind definer owner-bound, non-bypass and worker-only', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    expect(
      (
        await client.query(
          `SELECT procedure.prosecdef AS definer, procedure.proconfig AS config,
      role.rolsuper AS superuser, role.rolbypassrls AS bypass, role.rolname::text AS owner,
      EXISTS (SELECT 1 FROM aclexplode(procedure.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc procedure JOIN pg_roles role ON role.oid = procedure.proowner WHERE procedure.oid = $1::regprocedure`,
          [signature],
        )
      ).rows,
    ).toEqual([
      {
        definer: true,
        config: ['search_path=pg_catalog, pg_temp', 'row_security=on'],
        superuser: false,
        bypass: false,
        owner: roleNames.migrator,
        public_execute: false,
      },
    ])
    for (const role of ['api', 'worker', 'gc'] as const) {
      expect(
        (
          await client.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [
            roleNames[role],
            signature,
          ])
        ).rows,
      ).toEqual([{ allowed: role === 'worker' }])
    }
  })
})

it('transfers the binding across a queue retry and freezes the abandoned attempt', async () => {
  await withCapacityFixture(async (fixture) => {
    const retryBuildId = randomUUID()
    await capacityTransaction(
      fixture,
      async (transaction) => {
        await bindSeedBuild(transaction, fixture)
        await claimRetryBuildRow(transaction, fixture, retryBuildId, 1, fixture.id)
      },
      fixture.owners[0],
      'worker',
    )
    expect((await rebindAsWorker(fixture, retryBuildId, fixture.id, 1)).rows).toEqual([
      { status: 'REBOUND' },
    ])
    // 绑定已转移到重试attempt，generation未推进（自动重试不推进代数、不释放预留）。
    expect(await bindingFacts(fixture)).toEqual({
      current_build: retryBuildId,
      current_job: fixture.id,
      current_retry: '1',
      generation: '0',
    })
    // 旧attempt已冻结：worker内容写入被current-attempt门禁拒得（worker只有列级
    // INSERT，INSERT...SELECT探针需临时表级授权，随事务回滚，同build-security模式）；
    // 封存同样被拒；重试attempt是当前。
    await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
      await client.query(`GRANT INSERT ON knowledge.kb_source_units TO ${roleNames.worker}`)
      await client.query(`SET LOCAL ROLE ${roleNames.worker}`)
      const stale = await prepareContentInsert(client, fixture, 'kb_source_units')
      await client.query('SAVEPOINT stale_attempt')
      await expect(client.query(stale.text, stale.values)).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_build_current_attempt',
      })
      await client.query('ROLLBACK TO SAVEPOINT stale_attempt')
      expect(
        (await client.query('SELECT knowledge.seal_locked_build($1, $2, $3::jsonb, $4) AS status', [
          fixture.owners[0],
          fixture.id,
          {},
          new Date().toISOString(),
        ])).rows,
      ).toEqual([{ status: 'FORBIDDEN' }])
      expect(
        (
          await client.query('SELECT knowledge.has_current_build_attempt($1, $2) AS current', [
            fixture.owners[0],
            retryBuildId,
          ])
        ).rows,
      ).toEqual([{ current: true }])
    })
    // 幂等重放：同一重试attempt再次换绑。
    expect((await rebindAsWorker(fixture, retryBuildId, fixture.id, 1)).rows).toEqual([
      { status: 'REPLAYED' },
    ])
  })
})

it('refuses claim inserts outside the same-job immediately-prior retry', async () => {
  await withCapacityFixture(async (fixture) => {
    await capacityTransaction(
      fixture,
      (transaction) => bindSeedBuild(transaction, fixture),
      fixture.owners[0],
      'worker',
    )
    // 跳重试（retry 0→3）与换job的认领都在取消门被拒；运行时事务包装会
    // 吞掉PG错误码，这里用裸worker会话直插并断言约束身份。
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await bindSeedBuild(client, fixture)
      await client.query('SAVEPOINT claim_one')
      await expect(
        claimRetryBuildRow(client, fixture, randomUUID(), 3, fixture.id),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_build_cancel_fence',
      })
      await client.query('ROLLBACK TO SAVEPOINT claim_one')
      await expect(
        claimRetryBuildRow(client, fixture, randomUUID(), 1, randomUUID()),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_build_cancel_fence',
      })
    })
    expect(await bindingFacts(fixture)).toMatchObject({ current_retry: '0' })
  })
})

it('refuses rebind when the abandoned attempt was sealed', async () => {
  await withCapacityFixture(async (fixture) => {
    const retryBuildId = randomUUID()
    await capacityTransaction(
      fixture,
      async (transaction) => {
        await bindSeedBuild(transaction, fixture)
        await claimRetryBuildRow(transaction, fixture, retryBuildId, 1, fixture.id)
      },
      fixture.owners[0],
      'worker',
    )
    // inRoleTransaction回滚不落库：封存用bootstrap池直写。
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_builds SET ${closedBuildStates.sealed} WHERE owner_id = $1 AND id = $2`,
      [fixture.id],
    )
    expect((await rebindAsWorker(fixture, retryBuildId, fixture.id, 1)).rows).toEqual([
      { status: 'FORBIDDEN' },
    ])
    expect(await bindingFacts(fixture)).toMatchObject({ current_retry: '0' })
  })
})

it('refuses rebind after the operation left the claim window', async () => {
  await withCapacityFixture(async (fixture) => {
    const retryBuildId = randomUUID()
    await capacityTransaction(
      fixture,
      async (transaction) => {
        await bindSeedBuild(transaction, fixture)
        await claimRetryBuildRow(transaction, fixture, retryBuildId, 1, fixture.id)
      },
      fixture.owners[0],
      'worker',
    )
    await changeCapacityFixture(
      fixture,
      'UPDATE knowledge.kb_operations SET phase = $3, error_code = $4 WHERE owner_id = $1 AND id = $2',
      [fixture.id, 'failed', 'RESERVATION_EXPIRED'],
    )
    expect((await rebindAsWorker(fixture, retryBuildId, fixture.id, 1)).rows).toEqual([
      { status: 'FORBIDDEN' },
    ])
  })
})

it('hides cross-owner facts and refuses unauthenticated or invalid rebinds', async () => {
  await withCapacityFixture(async (fixture) => {
    for (const owner of [undefined, fixture.owners[1]]) {
      await inRoleTransaction('worker', owner, async (client) => {
        expect(
          (
            await client.query(
              'SELECT knowledge.rebind_operation_attempt($1, $2, $2, $2, 1, $2) AS status',
              [fixture.owners[0], fixture.id],
            )
          ).rows,
        ).toEqual([{ status: owner === undefined ? 'UNAUTHENTICATED' : 'NOT_FOUND' }])
      })
    }
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            'SELECT knowledge.rebind_operation_attempt($1, $2, $2, $2, 0, $2) AS status',
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([{ status: 'INVALID_REQUEST' }])
      expect(
        (
          await client.query(
            'SELECT knowledge.rebind_operation_attempt($1, $2, $2, $2, 1, $2) AS status',
            [fixture.owners[0], randomUUID()],
          )
        ).rows,
      ).toEqual([{ status: 'NOT_FOUND' }])
    })
  })
})

it('claims the retry attempt through the runtime claim path', async () => {
  await withCapacityFixture(async (fixture) => {
    const retryBuildId = randomUUID()
    await capacityTransaction(
      fixture,
      (transaction) => bindSeedBuild(transaction, fixture),
      fixture.owners[0],
      'worker',
    )
    await capacityTransaction(
      fixture,
      async (transaction) => {
        const profile = await transaction.query(
          'SELECT index_profile_id::text AS profile FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2',
          [fixture.owners[0], fixture.id],
        )
        const context = await claimBuild(
          transaction,
          { id: fixture.id, retryCount: 1 },
          envelopeFor(fixture, retryBuildId),
          {
            indexProfileId: (profile.rows[0] as { profile: string }).profile,
            parserRevision: 'synthetic',
            parserSnapshot: {},
          },
        )
        expect(context).toMatchObject({ buildId: retryBuildId, expectedGeneration: 0 })
      },
      fixture.owners[0],
      'worker',
    )
    expect(await bindingFacts(fixture)).toEqual({
      current_build: retryBuildId,
      current_job: fixture.id,
      current_retry: '1',
      generation: '0',
    })
  })
})