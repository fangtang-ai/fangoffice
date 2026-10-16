import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('immutable-security')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

it('records an independent incremental artifact while preserving the accepted baseline', async () => {
  const receipt = JSON.parse(
    await readFile(resolve(localDirectory, 'immutable-facts-receipt.json'), 'utf8'),
  ) as {
    instanceId: string
    baseline: { name: string; sha256: string }[]
    artifacts: { name: string; sha256: string }[]
  }
  const baseline = JSON.parse(
    await readFile(resolve(localDirectory, 'migration-receipt.json'), 'utf8'),
  ) as {
    artifacts: { name: string; sha256: string }[]
  }
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.baseline).toEqual(baseline.artifacts)
  expect(receipt.artifacts).toEqual([
    {
      name: 'security/immutable-facts.sql',
      sha256: createHash('sha256')
        .update(await readFile(resolve(serviceDirectory, 'security/immutable-facts.sql')))
        .digest('hex'),
    },
  ])
})

it('refuses incremental replay and preserves both receipts and live gates', async () => {
  const files = ['migration-receipt.json', 'immutable-facts-receipt.json']
  const before = await Promise.all(
    files.map((name) => readFile(resolve(localDirectory, name), 'utf8')),
  )
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(serviceDirectory, 'integration/apply-immutable-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the immutable-facts migration'),
  })
  expect(
    await Promise.all(files.map((name) => readFile(resolve(localDirectory, name), 'utf8'))),
  ).toEqual(before)
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    expect(
      (
        await client.query(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgname = 'kb_immutable_facts' AND tgenabled = 'O'`)
      ).rows,
    ).toEqual([{ count: 4 }])
  })
})

it('uses one invoker function with a fixed catalog search path and no runtime or PUBLIC execute grant', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    const functions = await client.query(`SELECT prosecdef AS definer, proconfig AS config,
      pg_get_userbyid(proowner) AS owner,
      EXISTS (SELECT 1 FROM aclexplode(proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc WHERE oid = 'knowledge.guard_immutable_facts()'::regprocedure`)
    expect(functions.rows).toEqual([
      {
        definer: false,
        config: ['search_path=pg_catalog'],
        owner: 'knowledge_migrator',
        public_execute: false,
      },
    ])
    const triggers = await client.query(`SELECT relation.relname::text AS table,
      trigger.tgtype::int AS type, trigger.tgenabled::text AS enabled,
      trigger.tgfoid = 'knowledge.guard_immutable_facts()'::regprocedure AS guarded
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
      WHERE relation.relnamespace = 'knowledge'::regnamespace
      AND trigger.tgname = 'kb_immutable_facts' ORDER BY relation.relname`)
    expect(triggers.rows).toEqual([
      { table: 'kb_billing_receipts', type: 27, enabled: 'O', guarded: true },
      { table: 'kb_index_profiles', type: 27, enabled: 'O', guarded: true },
      { table: 'kb_metering_events', type: 27, enabled: 'O', guarded: true },
      { table: 'kb_versions', type: 27, enabled: 'O', guarded: true },
    ])
    for (const role of [roleNames.api, roleNames.worker, roleNames.gc]) {
      expect(
        (
          await client.query(
            `SELECT has_function_privilege($1,
        'knowledge.guard_immutable_facts()', 'EXECUTE') AS allowed`,
            [role],
          )
        ).rows,
      ).toEqual([{ allowed: false }])
    }
  })
})

for (const role of ['api', 'worker', 'gc'] as const) {
  it(`enforces the gate for ${role} even with temporary narrow UPDATE grants and no function EXECUTE`, async () => {
    await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
      await client.query(
        `GRANT UPDATE (quantity, delivery_attempts) ON knowledge.kb_metering_events TO ${roleNames[role]}`,
      )
      await client.query(`SET LOCAL ROLE ${roleNames[role]}`)
      expect(
        (
          await client.query(
            `UPDATE knowledge.kb_metering_events SET delivery_attempts = 1
        WHERE owner_id = $1 AND id = $2`,
            [fixture.owners[0], fixture.id],
          )
        ).rowCount,
      ).toBe(1)
      await client.query('SAVEPOINT facts')
      await expect(
        client.query(
          `UPDATE knowledge.kb_metering_events SET quantity = 5
        WHERE owner_id = $1 AND id = $2`,
          [fixture.owners[0], fixture.id],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
      await client.query('ROLLBACK TO SAVEPOINT facts')
      expect(
        (await client.query('SELECT quantity, delivery_attempts FROM knowledge.kb_metering_events'))
          .rows,
      ).toEqual([{ quantity: '4', delivery_attempts: 1 }])
    })
    await inRoleTransaction(role, fixture.owners[0], async (client) => {
      await expect(
        client.query('UPDATE knowledge.kb_metering_events SET delivery_attempts = 1'),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it(`prevents ${role} from disabling the facts trigger through replication settings`, async () => {
    await inRoleTransaction(role, fixture.owners[0], async (client) => {
      await expect(
        client.query('SET LOCAL session_replication_role = replica'),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
}

it('has no self-reported session flag that bypasses the immutable facts gate', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    await client.query("SELECT set_config('knowledge.skip_immutable', 'true', true)")
    await expect(
      client.query(
        `UPDATE knowledge.kb_versions SET oss_key = 'changed'
      WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
  })
})

it('restores all guards when a synthetic bootstrap cleanup transaction rolls back', async () => {
  await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
    await client.query('SAVEPOINT cleanup')
    await client.query('ALTER TABLE knowledge.kb_versions DISABLE TRIGGER kb_immutable_facts')
    await expect(client.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' })
    await client.query('ROLLBACK TO SAVEPOINT cleanup')
    await expect(
      client.query(
        `UPDATE knowledge.kb_versions SET oss_key = 'changed'
      WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
  })
})

it('rolls back a failed incremental SQL batch without replacing the accepted gates', async () => {
  const sql = await readFile(resolve(serviceDirectory, 'security/immutable-facts.sql'), 'utf8')
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    const before = await client.query(
      `SELECT oid FROM pg_trigger WHERE tgname = 'kb_immutable_facts' ORDER BY oid`,
    )
    await client.query('SAVEPOINT migration')
    for (const table of [
      'kb_index_profiles',
      'kb_versions',
      'kb_metering_events',
      'kb_billing_receipts',
    ])
      await client.query(`DROP TRIGGER kb_immutable_facts ON knowledge.${table}`)
    await client.query('DROP TRIGGER kb_build_identity ON knowledge.kb_builds')
    await client.query('DROP FUNCTION knowledge.guard_immutable_facts()')
    await expect(client.query(`${sql}\nSELECT 1 / 0;`)).rejects.toMatchObject({ code: '22012' })
    await client.query('ROLLBACK TO SAVEPOINT migration')
    expect(
      (
        await client.query(
          `SELECT oid FROM pg_trigger WHERE tgname = 'kb_immutable_facts' ORDER BY oid`,
        )
      ).rows,
    ).toEqual(before.rows)
    await expect(
      client.query(
        `UPDATE knowledge.kb_versions SET oss_key = 'changed'
      WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
  })
})
