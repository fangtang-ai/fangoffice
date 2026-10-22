import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { bindSeedBuild } from './build-fixtures'
import { withCapacityFixture } from './capacity-fixtures'
import { roleNames } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

const signature = 'knowledge.bind_operation_attempt(text,uuid,uuid,uuid,integer,uuid)'

it('keeps the binding definer owner-bound, non-bypass and worker-only', async () => {
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
      expect(
        (
          await client.query(
            "SELECT has_any_column_privilege($1, 'knowledge.kb_operations', 'UPDATE') AS allowed",
            [roleNames[role]],
          )
        ).rows,
      ).toEqual([{ allowed: false }])
    }
  })
})

it.each(['api', 'gc'] as const)('denies %s binding execution', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query('SELECT knowledge.bind_operation_attempt(NULL, NULL, NULL, NULL, NULL, NULL)'),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('hides cross-owner facts and refuses unauthenticated binding', async () => {
  await withCapacityFixture(async (fixture) => {
    for (const owner of [undefined, fixture.owners[0]]) {
      await inRoleTransaction('worker', owner, async (client) => {
        expect(
          (
            await client.query(
              'SELECT knowledge.bind_operation_attempt($1, $2, $2, $2, 0, $2) AS status',
              [fixture.owners[1], fixture.id],
            )
          ).rows,
        ).toEqual([{ status: owner === undefined ? 'UNAUTHENTICATED' : 'NOT_FOUND' }])
      })
    }
  })
})

it.each([null, -1])('refuses invalid retry count %s without binding', async (retry) => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            'SELECT knowledge.bind_operation_attempt($1, $2, $2, $2, $3, $2) AS status',
            [fixture.owners[0], fixture.id, retry],
          )
        ).rows,
      ).toEqual([{ status: 'INVALID_REQUEST' }])
      expect(
        (
          await client.query(
            'SELECT current_build_id FROM knowledge.kb_operations WHERE owner_id = $1',
            [fixture.owners[0]],
          )
        ).rows,
      ).toEqual([{ current_build_id: null }])
    })
  })
})

it('refuses all partial bindings and negative persisted retries at the database boundary', async () => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('bootstrap', undefined, async (client) => {
      for (const assignment of [
        'current_job_id = id',
        'current_retry_count = 0',
        'current_build_id = id',
        'current_receipt_id = id',
        'current_job_id = id, current_retry_count = -1, current_build_id = id, current_receipt_id = id',
      ]) {
        await client.query('SAVEPOINT malformed_binding')
        await expect(
          client.query(`UPDATE knowledge.kb_operations SET ${assignment} WHERE owner_id = $1`, [
            fixture.owners[0],
          ]),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'kb_operations_current_binding_check',
        })
        await client.query('ROLLBACK TO SAVEPOINT malformed_binding')
      }
    })
  })
})

it('cannot replace the bound pending receipt with another same-owner pending receipt', async () => {
  await withCapacityFixture(async (fixture) => {
    const receiptId = randomUUID()
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await bindSeedBuild(client, fixture)
      // INSERT不授权给worker；另一个可信Receipt由同一bootstrap事务构造并回滚。
      await client.query('SAVEPOINT receipt_bypass')
      await expect(
        client.query(
          `INSERT INTO knowledge.kb_billing_receipts
        (owner_id, id, settlement_key, dimension, tariff_revision, settlement_snapshot, snapshot_hash)
        VALUES ($1, $2::uuid, $2::uuid::text, 'storage', 'synthetic', '{}', decode(repeat('ab', 32), 'hex'))`,
          [fixture.owners[0], receiptId],
        ),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT receipt_bypass')
    })
    await inRoleTransaction('bootstrap', undefined, async (client) => {
      await client.query(
        `INSERT INTO knowledge.kb_billing_receipts
        (owner_id, id, settlement_key, dimension, tariff_revision, settlement_snapshot, snapshot_hash)
        VALUES ($1, $2::uuid, $2::uuid::text, 'storage', 'synthetic', '{}', decode(repeat('ab', 32), 'hex'))`,
        [fixture.owners[0], receiptId],
      )
      await client.query('SET LOCAL ROLE knowledge_worker')
      await client.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
      await bindSeedBuild(client, fixture)
      expect(
        (
          await client.query(
            'SELECT knowledge.bind_operation_attempt($1, $2, $2, $2, 0, $3) AS status',
            [fixture.owners[0], fixture.id, receiptId],
          )
        ).rows,
      ).toEqual([{ status: 'FORBIDDEN' }])
    })
  })
})
