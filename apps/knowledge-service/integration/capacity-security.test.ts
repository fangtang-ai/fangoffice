import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { withCapacityFixture } from './capacity-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

const signature = 'knowledge.reserve_initial_capacity(uuid,bigint,bigint,timestamp with time zone)'
type GateReceipt = {
  instanceId: string
  baseline: { name: string; sha256: string }[]
  artifacts: { name: string; sha256: string }[]
}

it('preserves the accepted publication chain and exact capacity SQL hash', async () => {
  const receipt = JSON.parse(
    await readFile(resolve(localDirectory, 'capacity-reserve-receipt.json'), 'utf8'),
  ) as GateReceipt
  const prior = JSON.parse(
    await readFile(resolve(localDirectory, 'build-publish-receipt.json'), 'utf8'),
  ) as GateReceipt
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.baseline).toEqual([...prior.baseline, ...prior.artifacts])
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'security/capacity-reserve.sql',
  ])
  for (const artifact of [...receipt.baseline, ...receipt.artifacts])
    expect(
      createHash('sha256')
        .update(await readFile(resolve(serviceDirectory, artifact.name)))
        .digest('hex'),
    ).toBe(artifact.sha256)
})

it('refuses capacity migration replay without rewriting any accepted receipt', async () => {
  const files = [
    'migration',
    'immutable-facts',
    'build-content',
    'build-lifecycle',
    'build-publish',
    'capacity-reserve',
  ].map((name) => resolve(localDirectory, `${name}-receipt.json`))
  const before = await Promise.all(files.map((name) => readFile(name, 'utf8')))
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(serviceDirectory, 'integration/apply-capacity-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the capacity-reserve migration'),
  })
  expect(await Promise.all(files.map((name) => readFile(name, 'utf8')))).toEqual(before)
})

it('confines definer privileges to the FORCE-RLS migrator and API-only execute', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    const result = await client.query(
      `SELECT procedure.prosecdef AS definer, procedure.proconfig AS config,
      role.rolname::text AS owner, role.rolsuper AS superuser, role.rolbypassrls AS bypass,
      EXISTS (SELECT 1 FROM aclexplode(procedure.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc procedure JOIN pg_roles role ON role.oid = procedure.proowner
      WHERE procedure.oid = $1::regprocedure`,
      [signature],
    )
    expect(result.rows).toEqual([
      {
        definer: true,
        config: ['search_path=pg_catalog, pg_temp', 'row_security=on'],
        owner: roleNames.migrator,
        superuser: false,
        bypass: false,
        public_execute: false,
      },
    ])
    for (const role of ['api', 'worker', 'gc'] as const)
      expect(
        (
          await client.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [
            roleNames[role],
            signature,
          ])
        ).rows,
      ).toEqual([{ allowed: role === 'api' }])
    const tables = await client.query(
      `SELECT bool_and(relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner) = 'knowledge_migrator') AS restricted FROM pg_class WHERE relnamespace = 'knowledge'::regnamespace AND relname IN ('kb_quotas', 'kb_spaces', 'kb_documents', 'kb_operations', 'kb_versions', 'kb_reservations')`,
    )
    expect(tables.rows).toEqual([{ restricted: true }])
  })
})

it('returns unauthenticated without a transaction-local owner', async () => {
  await inRoleTransaction('api', undefined, async (client) => {
    expect(
      (
        await client.query(
          "SELECT knowledge.reserve_initial_capacity(gen_random_uuid(), 1, 16, now() + interval '1 hour') AS status",
        )
      ).rows,
    ).toEqual([{ status: 'UNAUTHENTICATED' }])
  })
})

it.each(['worker', 'gc'] as const)(
  'denies the %s role access to the reservation function',
  async (role) => {
    await inRoleTransaction(role, undefined, async (client) => {
      await expect(
        client.query(
          "SELECT knowledge.reserve_initial_capacity(gen_random_uuid(), 1, 16, now() + interval '1 hour')",
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  },
)

it.each([
  'UPDATE knowledge.kb_quotas SET reserved_files = reserved_files + 1 WHERE owner_id = $1',
  'UPDATE knowledge.kb_documents SET desired_operation_id = id, desired_version_id = id WHERE owner_id = $1',
  'UPDATE knowledge.kb_reservations SET reserved_files = reserved_files + 1 WHERE owner_id = $1',
])('denies direct API writes outside the narrow admission entry: %s', async (statement) => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      await expect(client.query(statement, [fixture.owners[0]])).rejects.toMatchObject({
        code: '42501',
      })
    })
  })
})
