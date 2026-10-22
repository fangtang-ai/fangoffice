import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { readEmbeddingAttempt, recordEmbeddingIntent, recordEmbeddingResult } from '../src/runtime'
import { capacityTransaction, withCapacityFixture } from './capacity-fixtures'
import { embeddingIntent, embeddingResult, embeddingTransaction } from './embedding-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

const signature =
  'knowledge.record_embedding_event(uuid,uuid,text,text,numeric,uuid,uuid,uuid,uuid,uuid,text)'

it('hash-checks the independent index/function increment and refuses replay', async () => {
  const path = resolve(localDirectory, 'embedding-attempt-receipt.json')
  const before = await readFile(path, 'utf8')
  const receipt = JSON.parse(before) as {
    instanceId: string
    baseline: { name: string; sha256: string }[]
    artifacts: { name: string; sha256: string }[]
  }
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'drizzle/0004_embedding_attempt.sql',
    'security/embedding-attempt.sql',
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
        resolve(serviceDirectory, 'integration/apply-embedding-attempt-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the embedding-attempt migration'),
  })
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('keeps the definer worker-only, RLS-bound and without direct metering writes', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    expect(
      (
        await client.query(
          `SELECT procedure.prosecdef AS definer, procedure.proconfig AS config,
      role.rolname::text AS owner, role.rolsuper AS superuser, role.rolbypassrls AS bypass,
      EXISTS (SELECT 1 FROM aclexplode(procedure.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc procedure JOIN pg_roles role ON role.oid = procedure.proowner WHERE procedure.oid = $1::regprocedure`,
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
          await client.query(
            `SELECT has_function_privilege($1,$2,'EXECUTE') AS execute,
        has_any_column_privilege($1,'knowledge.kb_metering_events','INSERT') AS insert,
        has_any_column_privilege($1,'knowledge.kb_metering_events','UPDATE') AS update,
        has_table_privilege($1,'knowledge.kb_metering_events','DELETE') AS delete`,
            [roleNames[role], signature],
          )
        ).rows,
      ).toEqual([{ execute: role === 'worker', insert: false, update: false, delete: false }])
  })
})

it.each(['api', 'gc'] as const)('denies direct execution by %s', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query(
        'SELECT knowledge.record_embedding_event(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)',
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('requires an owner and hides another owner intent and correction chain', async () => {
  await withCapacityFixture(async (fixture) => {
    await inRoleTransaction('worker', undefined, async (client) => {
      expect(
        (
          await client.query(
            'SELECT knowledge.record_embedding_event(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL) AS status',
          )
        ).rows,
      ).toEqual([{ status: 'UNAUTHENTICATED' }])
    })
    const intent = embeddingIntent(fixture)
    await embeddingTransaction(fixture, (transaction) => recordEmbeddingIntent(transaction, intent))
    for (const work of [
      (transaction: Parameters<typeof readEmbeddingAttempt>[0]) =>
        readEmbeddingAttempt(transaction, intent.attemptId),
      (transaction: Parameters<typeof readEmbeddingAttempt>[0]) =>
        recordEmbeddingResult(transaction, embeddingResult(intent.attemptId)),
    ])
      await expect(
        capacityTransaction(
          fixture,
          async (transaction) => {
            await work(transaction)
          },
          fixture.owners[1],
          'worker',
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      inRoleTransaction('bootstrap', undefined, (client) =>
        client.query(
          'UPDATE knowledge.kb_metering_events SET quantity = 0 WHERE owner_id = $1 AND id = $2',
          [fixture.owners[0], intent.eventId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
  })
})
