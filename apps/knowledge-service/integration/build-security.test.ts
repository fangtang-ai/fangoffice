import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  bindSeedBuild,
  changeBuild,
  closedBuildStates,
  prepareContentInsert,
} from './build-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('build-security')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

it('records the exact content supplement chained to both accepted local baselines', async () => {
  const receipt = JSON.parse(
    await readFile(resolve(localDirectory, 'build-content-receipt.json'), 'utf8'),
  ) as {
    instanceId: string
    baseline: { name: string; sha256: string }[]
    artifacts: { name: string; sha256: string }[]
  }
  const prior = JSON.parse(
    await readFile(resolve(localDirectory, 'immutable-facts-receipt.json'), 'utf8'),
  ) as {
    baseline: { name: string; sha256: string }[]
    artifacts: { name: string; sha256: string }[]
  }
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.baseline).toEqual([...prior.baseline, ...prior.artifacts])
  for (const artifact of [...receipt.baseline, ...receipt.artifacts])
    expect(
      createHash('sha256')
        .update(await readFile(resolve(serviceDirectory, artifact.name)))
        .digest('hex'),
    ).toBe(artifact.sha256)
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual(['security/build-content.sql'])
})

it('refuses replay without changing any accepted receipt', async () => {
  const files = [
    'migration-receipt.json',
    'immutable-facts-receipt.json',
    'build-content-receipt.json',
  ]
  const before = await Promise.all(
    files.map((name) => readFile(resolve(localDirectory, name), 'utf8')),
  )
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(serviceDirectory, 'integration/apply-build-content-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the build-content migration'),
  })
  expect(
    await Promise.all(files.map((name) => readFile(resolve(localDirectory, name), 'utf8'))),
  ).toEqual(before)
})

it('keeps both gate functions unprivileged and all six new triggers enabled', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    const functions = await client.query(`SELECT proname, prosecdef AS definer, proconfig AS config,
      pg_get_userbyid(proowner) AS owner,
      EXISTS (SELECT 1 FROM aclexplode(proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc WHERE pronamespace = 'knowledge'::regnamespace
      AND proname IN ('guard_build_content', 'guard_build_state') ORDER BY proname`)
    expect(functions.rows).toEqual(
      ['guard_build_content', 'guard_build_state'].map((proname) => ({
        proname,
        definer: false,
        config: ['search_path=pg_catalog'],
        owner: 'knowledge_migrator',
        public_execute: false,
      })),
    )
    const triggers =
      await client.query(`SELECT relation.relname::text AS table, trigger.tgname::text AS name,
      trigger.tgenabled::text AS enabled FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid = trigger.tgrelid
      WHERE relation.relnamespace = 'knowledge'::regnamespace
      AND trigger.tgname IN ('kb_build_content', 'kb_build_identity', 'kb_build_state')
      ORDER BY relation.relname, trigger.tgname`)
    expect(triggers.rows).toEqual([
      { table: 'kb_builds', name: 'kb_build_identity', enabled: 'O' },
      { table: 'kb_builds', name: 'kb_build_state', enabled: 'O' },
      { table: 'kb_chunk_embeddings', name: 'kb_build_content', enabled: 'O' },
      { table: 'kb_chunk_sources', name: 'kb_build_content', enabled: 'O' },
      { table: 'kb_chunks', name: 'kb_build_content', enabled: 'O' },
      { table: 'kb_source_units', name: 'kb_build_content', enabled: 'O' },
    ])
    for (const role of [roleNames.api, roleNames.worker, roleNames.gc])
      for (const name of ['guard_build_content', 'guard_build_state'])
        expect(
          (
            await client.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [
              role,
              `knowledge.${name}()`,
            ])
          ).rows,
        ).toEqual([{ allowed: false }])
  })
})

// B6 后 worker 持有持久 INSERT（列级）与 kb_builds 列特权；门按列特权放行/拒绝。
// worker 的授权面是列级 INSERT，必须用显式列清单（全列 INSERT 需要表级特权，非 B6 授权面）。
function workerInsert() {
  return {
    text: `INSERT INTO knowledge.kb_source_units
      (owner_id, build_id, id, parent_id, ordinal, type, text, text_hash, locator, coverage, warnings)
    SELECT owner_id, build_id, gen_random_uuid(), parent_id, ordinal + 9999, type, text,
           text_hash, locator, coverage, warnings
      FROM knowledge.kb_source_units sample WHERE owner_id = $1 AND build_id = $2 LIMIT 1`,
    values: [fixture.owners[0], fixture.id],
  }
}
it('enforces the worker content gate without direct build UPDATE privileges', async () => {
  await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
    await bindSeedBuild(client, fixture)
    const insert = workerInsert()
    await client.query(`SET LOCAL ROLE ${roleNames.worker}`)
    expect(
      (
        await client.query(
          "SELECT has_any_column_privilege(current_user, 'knowledge.kb_builds', 'UPDATE') AS writable",
        )
      ).rows,
    ).toEqual([{ writable: false }])
    expect((await client.query(insert.text, insert.values)).rowCount).toBe(1)
    await client.query('RESET ROLE')
    await changeBuild(client, fixture, closedBuildStates.sealed)
    await client.query(`SET LOCAL ROLE ${roleNames.worker}`)
    await expect(client.query(insert.text, insert.values)).rejects.toMatchObject({
      code: '23514',
      constraint: 'kb_build_writable',
    })
  })
})

for (const role of ['api', 'gc'] as const) {
  it(`enforces ${role} content gates without an elevated function or persistent write grants`, async () => {
    await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
      const insert = await prepareContentInsert(client, fixture, 'kb_source_units')
      await client.query(`GRANT INSERT ON knowledge.kb_source_units TO ${roleNames[role]}`)
      await client.query(`SET LOCAL ROLE ${roleNames[role]}`)
      await client.query('SAVEPOINT row_lock_privilege')
      await expect(client.query(insert.text, insert.values)).rejects.toMatchObject({
        code: '42501',
      })
      await client.query('ROLLBACK TO SAVEPOINT row_lock_privilege')
      await client.query('RESET ROLE')
      await client.query(
        `GRANT UPDATE (source_unit_count) ON knowledge.kb_builds TO ${roleNames[role]}`,
      )
      await client.query(`SET LOCAL ROLE ${roleNames[role]}`)
      expect((await client.query(insert.text, insert.values)).rowCount).toBe(1)
      await client.query('RESET ROLE')
      await changeBuild(client, fixture, closedBuildStates.sealed)
      await client.query(`SET LOCAL ROLE ${roleNames[role]}`)
      await expect(client.query(insert.text, insert.values)).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_build_writable',
      })
    })
    await inRoleTransaction(role, fixture.owners[0], async (client) => {
      const insert = await prepareContentInsert(client, fixture, 'kb_source_units')
      await expect(client.query(insert.text, insert.values)).rejects.toMatchObject({
        code: '42501',
      })
    })
  })

  it(`prevents ${role} from disabling a content gate`, async () => {
    await inRoleTransaction(role, fixture.owners[0], async (client) => {
      await expect(
        client.query('ALTER TABLE knowledge.kb_source_units DISABLE TRIGGER kb_build_content'),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
}

it('rolls back failed content-gate DDL without replacing the accepted trigger identities', async () => {
  const sql = await readFile(resolve(serviceDirectory, 'security/build-content.sql'), 'utf8')
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    const before = await client.query(`SELECT oid FROM pg_trigger
      WHERE tgname IN ('kb_build_content', 'kb_build_identity', 'kb_build_state') ORDER BY oid`)
    await client.query('SAVEPOINT gates')
    for (const table of ['kb_source_units', 'kb_chunks', 'kb_chunk_sources', 'kb_chunk_embeddings'])
      await client.query(`DROP TRIGGER kb_build_content ON knowledge.${table}`)
    await client.query('DROP TRIGGER kb_build_identity ON knowledge.kb_builds')
    await client.query('DROP TRIGGER kb_build_state ON knowledge.kb_builds')
    await client.query('DROP FUNCTION knowledge.guard_build_content()')
    await client.query('DROP FUNCTION knowledge.guard_build_state()')
    await expect(client.query(`${sql}\nSELECT 1 / 0;`)).rejects.toMatchObject({ code: '22012' })
    await client.query('ROLLBACK TO SAVEPOINT gates')
    expect(
      (
        await client.query(`SELECT oid FROM pg_trigger
      WHERE tgname IN ('kb_build_content', 'kb_build_identity', 'kb_build_state') ORDER BY oid`)
      ).rows,
    ).toEqual(before.rows)
    await changeBuild(client, fixture, closedBuildStates.sealed)
    const insert = await prepareContentInsert(client, fixture, 'kb_source_units')
    await expect(client.query(insert.text, insert.values)).rejects.toMatchObject({
      code: '23514',
      constraint: 'kb_build_writable',
    })
  })
})

it('denies direct runtime publication and retains the underlying publication trigger', async () => {
  for (const role of ['api', 'worker', 'gc'] as const)
    await inRoleTransaction(role, fixture.owners[0], async (client) => {
      await expect(
        client.query(
          `UPDATE knowledge.kb_documents SET active_build_id = $3
            WHERE owner_id = $1 AND id = $2`,
          [fixture.owners[0], fixture.id, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })

  await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
    await bindSeedBuild(client, fixture)
    await changeBuild(client, fixture, closedBuildStates.sealed)
    // admission 面：desired 指针与发布窗口由 bootstrap 维护（写入方无授权）。
    await client.query(
      `UPDATE knowledge.kb_documents SET desired_operation_id = $2, desired_version_id = $3
        WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id, fixture.id],
    )
    await client.query(
      `UPDATE knowledge.kb_operations SET phase = 'indexing' WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )

    const deny = async (text: string, values: unknown[]) => {
      await client.query('SAVEPOINT publish_gate')
      await expect(client.query(text, values)).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_document_publish_gate',
      })
      await client.query('ROLLBACK TO SAVEPOINT publish_gate')
      await client.query('RESET ROLE')
    }

    // 形状：指针未移动的 generation 自增（代数操纵）。
    await deny(
      `UPDATE knowledge.kb_documents SET generation = generation + 1
        WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    // 形状：指针移动但代数未 +1。
    await deny(
      `UPDATE knowledge.kb_documents SET active_version_id = $3, active_build_id = $3
        WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id, fixture.id],
    )
    // 业务列（title）不在 worker 授权面：特权层先于门拒绝（42501）。
    await client.query('SAVEPOINT publish_gate')
    await client.query(`SET LOCAL ROLE ${roleNames.worker}`)
    await expect(
      client.query(
        `UPDATE knowledge.kb_documents
            SET active_version_id = $3, active_build_id = $3, generation = generation + 1,
                title = 'changed'
          WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id, fixture.id],
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT publish_gate')
    await client.query('RESET ROLE')
    // 门形状规则对持有业务列授权的角色仍生效：指针翻转顺手改标题 → 23514。
    await client.query('SAVEPOINT publish_gate')
    await expect(
      client.query(
        `UPDATE knowledge.kb_documents
            SET active_version_id = $3, active_build_id = $3, generation = generation + 1,
                title = 'changed'
          WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id, fixture.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'kb_document_publish_gate',
    })
    await client.query('ROLLBACK TO SAVEPOINT publish_gate')
    // desired 列不在 worker 授权面：admission 语义不可被写入方伪造。
    await client.query('SAVEPOINT publish_gate')
    await client.query(`SET LOCAL ROLE ${roleNames.worker}`)
    await expect(
      client.query(
        `UPDATE knowledge.kb_documents SET desired_operation_id = $3
          WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await client.query('ROLLBACK TO SAVEPOINT publish_gate')
    await client.query('RESET ROLE')
    // 仅bootstrap验证底层门；运行角色必须调用带容量转正的发布入口。
    expect(
      (
        await client.query(
          `UPDATE knowledge.kb_documents
              SET active_version_id = $3, active_build_id = $3, generation = generation + 1
            WHERE owner_id = $1 AND id = $2`,
          [fixture.owners[0], fixture.id, fixture.id],
        )
      ).rowCount,
    ).toBe(1)
    await client.query('RESET ROLE')
    // 重复发布：指针已就位后同列重写 → 形状拒绝。
    await client.query('SAVEPOINT publish_gate')
    await expect(
      client.query(
        `UPDATE knowledge.kb_documents
            SET active_version_id = $3, active_build_id = $3, generation = generation + 1
          WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id, fixture.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'kb_document_publish_gate',
    })
    await client.query('ROLLBACK TO SAVEPOINT publish_gate')
    await client.query('RESET ROLE')
  })
})
