import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { reserveReplacementCapacity } from '../src/runtime'
import { capacityTransaction, changeCapacityFixture } from './capacity-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { replacementInput, replacementState, withReplacementFixture } from './replacement-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

const signature =
  'knowledge.reserve_replacement_capacity(uuid,bigint,bigint,timestamp with time zone)'
type GateReceipt = {
  instanceId: string
  baseline: { name: string; sha256: string }[]
  artifacts: { name: string; sha256: string }[]
}

it('hashes the generated schema and narrow function as one increment chained to initial admission', async () => {
  const receipt = JSON.parse(
    await readFile(resolve(localDirectory, 'replacement-reserve-receipt.json'), 'utf8'),
  ) as GateReceipt
  const prior = JSON.parse(
    await readFile(resolve(localDirectory, 'capacity-reserve-receipt.json'), 'utf8'),
  ) as GateReceipt
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.baseline).toEqual([...prior.baseline, ...prior.artifacts])
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'drizzle/0001_capacity_projection.sql',
    'security/replacement-reserve.sql',
  ])
  for (const artifact of [...receipt.baseline, ...receipt.artifacts])
    expect(
      createHash('sha256')
        .update(await readFile(resolve(serviceDirectory, artifact.name)))
        .digest('hex'),
    ).toBe(artifact.sha256)
})

it('refuses replay without replacing any previously accepted receipt', async () => {
  const files = [
    'migration',
    'immutable-facts',
    'build-content',
    'build-lifecycle',
    'build-publish',
    'capacity-reserve',
    'replacement-reserve',
  ].map((name) => resolve(localDirectory, `${name}-receipt.json`))
  const before = await Promise.all(files.map((name) => readFile(name, 'utf8')))
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(serviceDirectory, 'integration/apply-replacement-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the replacement-reserve migration'),
  })
  expect(await Promise.all(files.map((name) => readFile(name, 'utf8')))).toEqual(before)
})

it('keeps replacement execute API-only under the FORCE-RLS non-bypass migrator', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    expect(
      (
        await client.query(
          `SELECT procedure.prosecdef AS definer, procedure.proconfig AS config,
      role.rolname::text AS owner, role.rolsuper AS superuser, role.rolbypassrls AS bypass,
      EXISTS (SELECT 1 FROM aclexplode(procedure.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc procedure JOIN pg_roles role ON role.oid = procedure.proowner
      WHERE procedure.oid = $1::regprocedure`,
          [signature],
        )
      ).rows,
    ).toEqual([
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
  })
})

it('does not resolve any replacement without an owner identity', async () => {
  await inRoleTransaction('api', undefined, async (client) => {
    expect(
      (
        await client.query(
          "SELECT knowledge.reserve_replacement_capacity(gen_random_uuid(), 3, 32, now() + interval '1 hour') AS status",
        )
      ).rows,
    ).toEqual([{ status: 'UNAUTHENTICATED' }])
  })
})

it.each(['worker', 'gc'] as const)(
  'denies the %s role direct replacement execution',
  async (role) => {
    await inRoleTransaction(role, undefined, async (client) => {
      await expect(
        client.query(
          "SELECT knowledge.reserve_replacement_capacity(gen_random_uuid(), 3, 32, now() + interval '1 hour')",
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  },
)

it.each(['NULL', '-1'])(
  'rejects an invalid persisted replacement projection %s at the database boundary',
  async (value) => {
    await withReplacementFixture(async (fixture) => {
      await capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, replacementInput(fixture)),
      )
      await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
        await expect(
          client.query(
            `UPDATE knowledge.kb_reservations SET projected_chunks = ${value} WHERE owner_id = $1`,
            [fixture.owners[0]],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'kb_reservations_projection_check' })
      })
    })
  },
)

it.each([
  'UPDATE knowledge.kb_reservations SET base_version_id = NULL, base_build_id = NULL WHERE owner_id = $1',
  'UPDATE knowledge.kb_documents SET desired_version_id = id, desired_operation_id = id WHERE owner_id = $1 AND active_build_id IS NOT NULL',
])('refuses replay against changed base/desired facts: %s', async (statement) => {
  await withReplacementFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveReplacementCapacity(transaction, replacementInput(fixture)),
    )
    await changeCapacityFixture(fixture, statement)
    const before = await replacementState(fixture)
    await expect(
      capacityTransaction(fixture, (transaction) =>
        reserveReplacementCapacity(transaction, replacementInput(fixture)),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await replacementState(fixture)).toEqual(before)
  })
})

it('does not grant API direct writes to the newly persisted projection', async () => {
  await withReplacementFixture(async (fixture) => {
    await capacityTransaction(fixture, (transaction) =>
      reserveReplacementCapacity(transaction, replacementInput(fixture)),
    )
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      await expect(
        client.query(
          'UPDATE knowledge.kb_reservations SET projected_chunks = 0 WHERE owner_id = $1',
          [fixture.owners[0]],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
})
