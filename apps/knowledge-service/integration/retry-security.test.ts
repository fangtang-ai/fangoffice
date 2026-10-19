import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { withRetryFixture } from './retry-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

const signature = 'knowledge.reserve_retry_capacity(uuid,bigint,bigint,timestamp with time zone)'
type Receipt = {
  instanceId: string
  baseline: { name: string; sha256: string }[]
  artifacts: { name: string; sha256: string }[]
}

it('extends the accepted cancellation chain without changing any historical SQL or receipt', async () => {
  const prior = JSON.parse(
    await readFile(resolve(localDirectory, 'capacity-cancel-worker-receipt.json'), 'utf8'),
  ) as Receipt
  const receipt = JSON.parse(
    await readFile(resolve(localDirectory, 'capacity-retry-receipt.json'), 'utf8'),
  ) as Receipt
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.baseline).toEqual([...prior.baseline, ...prior.artifacts])
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'security/capacity-retry.sql',
  ])
  const paths = [
    'migration',
    'immutable-facts',
    'build-content',
    'build-lifecycle',
    'build-publish',
    'capacity-reserve',
    'replacement-reserve',
    'capacity-cancel',
    'capacity-cancel-publish',
    'capacity-cancel-worker',
    'capacity-retry',
  ].map((name) => resolve(localDirectory, `${name}-receipt.json`))
  const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')))
  for (const artifact of [...receipt.baseline, ...receipt.artifacts])
    expect(
      createHash('sha256')
        .update(await readFile(resolve(serviceDirectory, artifact.name)))
        .digest('hex'),
    ).toBe(artifact.sha256)
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(serviceDirectory, 'integration/apply-retry-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the capacity-retry migration'),
  })
  expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(before)
})

it('confines retry definer privileges to the FORCE-RLS migrator and API-only execute', async () => {
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

it.each(['worker', 'gc'] as const)('denies %s direct retry admission', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query(
        "SELECT knowledge.reserve_retry_capacity($1, 1, 16, now() + interval '1 hour')",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('refuses retry without a trusted transaction owner', async () => {
  await inRoleTransaction('api', undefined, async (client) => {
    expect(
      (
        await client.query(
          "SELECT knowledge.reserve_retry_capacity($1, 1, 16, now() + interval '1 hour') AS status",
          [randomUUID()],
        )
      ).rows,
    ).toEqual([{ status: 'UNAUTHENTICATED' }])
  })
})

it.each([
  'UPDATE knowledge.kb_quotas SET reserved_files = reserved_files + 1 WHERE owner_id = $1',
  'UPDATE knowledge.kb_documents SET desired_operation_id = $2, desired_version_id = $2 WHERE owner_id = $1',
  'UPDATE knowledge.kb_operations SET expected_generation = 1 WHERE owner_id = $1',
  "UPDATE knowledge.kb_reservations SET state = 'held', closed_at = NULL WHERE owner_id = $1",
])('does not grant API direct retry writes: %s', async (statement) => {
  await withRetryFixture(async (fixture) => {
    await inRoleTransaction('api', fixture.owners[0], async (client) => {
      await expect(
        client.query(
          statement,
          statement.includes('$2') ? [fixture.owners[0], fixture.retryId] : [fixture.owners[0]],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
})
