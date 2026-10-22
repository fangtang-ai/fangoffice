import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareKnowledgeUpload } from '../src/runtime'
import { capacityTransaction, withCapacityFixture } from './capacity-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'
import { uploadPolicy, uploadRequest } from './upload-fixtures'

const signatures = [
  'knowledge.create_space(uuid,text)',
  'knowledge.create_document(uuid,uuid,text,text[],text)',
  'knowledge.prepare_upload(uuid,text,uuid,uuid,bigint,bigint,text,bigint)',
]

it.each(['worker', 'gc'] as const)('denies direct metadata creation by %s', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(client.query('SELECT knowledge.create_space(NULL,NULL)')).rejects.toMatchObject({
      code: '42501',
    })
  })
})

it('keeps all creation entries API-only and direct document/operation writes denied', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    for (const signature of signatures) {
      expect(
        (
          await client.query(
            `SELECT p.prosecdef AS definer, p.proconfig AS config,
        r.rolname::text AS owner, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
        EXISTS(SELECT 1 FROM aclexplode(p.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
        FROM pg_proc p JOIN pg_roles r ON p.proowner = r.oid WHERE p.oid = $1::regprocedure`,
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
            await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS execute", [
              roleNames[role],
              signature,
            ])
          ).rows,
        ).toEqual([{ execute: role === 'api' }])
    }
    for (const table of ['kb_documents', 'kb_operations'])
      expect(
        (
          await client.query("SELECT has_any_column_privilege($1,$2,'INSERT') AS insert", [
            roleNames.api,
            `knowledge.${table}`,
          ])
        ).rows,
      ).toEqual([{ insert: false }])
  })
})

it('requires trusted owner binding and never reads a different owner session', async () => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('api', undefined, async (client) => {
      expect(
        (
          await client.query(
            'SELECT knowledge.prepare_upload(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL) AS status',
          )
        ).rows,
      ).toEqual([{ status: 'UNAUTHENTICATED' }])
    })
    const input = uploadRequest(fixture)
    await capacityTransaction(fixture, (transaction) =>
      prepareKnowledgeUpload(transaction, input, uploadPolicy),
    )
    await inRoleTransaction('api', fixture.owners[1], async (client) => {
      expect(
        (
          await client.query('SELECT staging_key FROM knowledge.kb_operations WHERE id = $1', [
            input.operationId,
          ])
        ).rows,
      ).toEqual([])
    })
    await expect(
      capacityTransaction(
        fixture,
        (transaction) => prepareKnowledgeUpload(transaction, input, uploadPolicy),
        'synthetic-missing-owner',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

it('hash-checks the index/function increment and refuses replay without changing receipts', async () => {
  const path = resolve(localDirectory, 'upload-preparation-receipt.json')
  const before = await readFile(path, 'utf8')
  const receipt = JSON.parse(before) as {
    instanceId: string
    baseline: { name: string; sha256: string }[]
    artifacts: { name: string; sha256: string }[]
  }
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'drizzle/0005_upload_preparation.sql',
    'security/upload-preparation.sql',
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
        resolve(serviceDirectory, 'integration/apply-upload-preparation-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the upload-preparation migration'),
  })
  expect(await readFile(path, 'utf8')).toBe(before)
})
