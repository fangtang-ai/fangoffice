import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { localDirectory, roleNames, serviceDirectory } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

const signature = 'knowledge.publish_reserved_build(text,uuid,uuid,uuid,uuid,uuid)'
type Receipt = {
  instanceId: string
  baseline: { name: string; sha256: string }[]
  artifacts: { name: string; sha256: string }[]
}

it('preserves the accepted hash chain and refuses publication migration replay', async () => {
  const path = resolve(localDirectory, 'capacity-publish-receipt.json')
  const original = await readFile(path, 'utf8')
  const receipt = JSON.parse(original) as Receipt
  const prior = JSON.parse(
    await readFile(resolve(localDirectory, 'capacity-retry-receipt.json'), 'utf8'),
  ) as Receipt
  expect(receipt.instanceId).toBe(prior.instanceId)
  expect(receipt.baseline).toEqual([...prior.baseline, ...prior.artifacts])
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'security/capacity-publish.sql',
  ])
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
        resolve(serviceDirectory, 'integration/apply-capacity-publish-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the capacity-publish migration'),
  })
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('uses a non-bypass definer and grants only worker execution, not document writes', async () => {
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
    for (const role of ['api', 'worker', 'gc'] as const) {
      expect(
        (
          await client.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [
            roleNames[role],
            signature,
          ])
        ).rows,
      ).toEqual([{ allowed: role === 'worker' }])
      for (const column of ['active_version_id', 'active_build_id', 'generation'])
        expect(
          (
            await client.query(
              "SELECT has_column_privilege($1, 'knowledge.kb_documents', $2, 'UPDATE') AS allowed",
              [roleNames[role], column],
            )
          ).rows,
        ).toEqual([{ allowed: false }])
    }
  })
})

it.each(['api', 'gc'] as const)('denies %s execution of the publication entry', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query('SELECT knowledge.publish_reserved_build(NULL, NULL, NULL, NULL, NULL, NULL)'),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('refuses publication without a trusted transaction owner', async () => {
  await inRoleTransaction('worker', undefined, async (client) => {
    expect(
      (
        await client.query(
          'SELECT knowledge.publish_reserved_build(NULL, NULL, NULL, NULL, NULL, NULL) AS status',
        )
      ).rows,
    ).toEqual([{ status: 'UNAUTHENTICATED' }])
  })
})
