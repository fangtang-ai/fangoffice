import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { completeKnowledgeUpload } from '../src/runtime'
import { capacityTransaction, changeCapacityFixture } from './capacity-fixtures'
import { inRoleTransaction } from './tenant-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import { withUploadCompletion } from './upload-completion-fixtures'

const signatures = [
  'knowledge.lock_upload_completion(uuid,uuid,uuid,bigint)',
  'knowledge.complete_upload(uuid,uuid,uuid,bigint,uuid,text,text,bytea,bigint,text,bigint,bigint,timestamptz,text,uuid,jsonb,bigint)',
]

it.each(['worker', 'gc'] as const)('denies completion locking to %s', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query('SELECT knowledge.lock_upload_completion(NULL,NULL,NULL,NULL)'),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('keeps both functions definer-owned, tenant-bound, API-only and without direct table-write grants', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    for (const signature of signatures) {
      expect(
        (
          await client.query(
            `SELECT p.prosecdef AS definer,p.proconfig AS config,r.rolname::text AS owner,
        r.rolsuper AS superuser,r.rolbypassrls AS bypass,
        EXISTS(SELECT 1 FROM aclexplode(p.proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
        FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`,
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
    for (const role of ['api', 'worker', 'gc'] as const) {
      for (const column of ['upload_job_id', 'upload_queue_name'])
        expect(
          (
            await client.query(
              "SELECT has_column_privilege($1,'knowledge.kb_operations',$2,'UPDATE') AS write",
              [roleNames[role], column],
            )
          ).rows,
        ).toEqual([{ write: false }])
      expect(
        (
          await client.query(
            "SELECT has_any_column_privilege($1,'knowledge.kb_versions','INSERT') AS write",
            [roleNames[role]],
          )
        ).rows,
      ).toEqual([{ write: false }])
    }
  })
})

it('requires authenticated owner binding even for an otherwise empty call', async () => {
  await inRoleTransaction('api', undefined, async (client) => {
    expect(
      (await client.query('SELECT knowledge.lock_upload_completion(NULL,NULL,NULL,NULL) AS status'))
        .rows,
    ).toEqual([{ status: 'UNAUTHENTICATED' }])
  })
})

it('does not complete a different owner upload', async () => {
  await withUploadCompletion(async (fixture) => {
    await expect(
      capacityTransaction(
        fixture,
        (transaction) => completeKnowledgeUpload(transaction, fixture.input, fixture.policy),
        fixture.owners[1],
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
            fixture.policy.queueName,
          ])
        ).rows,
      ).toEqual([])
    })
  })
})

it.each(['owner', 'space', 'deleted-space', 'generation', 'expiry'] as const)(
  'rechecks persisted %s after object verification',
  async (gate) => {
    await withUploadCompletion(async (fixture) => {
      const queries = {
        owner: "UPDATE knowledge.kb_quotas SET owner_state='frozen' WHERE owner_id=$1",
        space: "UPDATE knowledge.kb_spaces SET state='frozen' WHERE owner_id=$1 AND id=$2",
        'deleted-space':
          "UPDATE knowledge.kb_spaces SET state='deleted',deleted_at=clock_timestamp() WHERE owner_id=$1 AND id=$2",
        generation:
          'UPDATE knowledge.kb_documents SET generation=generation+1 WHERE owner_id=$1 AND id=$2',
        expiry:
          "UPDATE knowledge.kb_operations SET upload_expires_at=clock_timestamp()-interval '1s' WHERE owner_id=$1 AND id=$2",
      }
      const target =
        gate === 'generation'
          ? fixture.otherDocumentId
          : gate === 'expiry'
            ? fixture.input.prepared.operation.id
            : fixture.id
      if (gate !== 'generation')
        await changeCapacityFixture(fixture, queries[gate], gate === 'owner' ? [] : [target])
      const input =
        gate === 'generation'
          ? {
              ...fixture.input,
              prepared: {
                ...fixture.input.prepared,
                operation: { ...fixture.input.prepared.operation, expectedGeneration: '1' },
              },
            }
          : fixture.input
      await expect(
        capacityTransaction(fixture, (transaction) =>
          completeKnowledgeUpload(transaction, input, fixture.policy),
        ),
      ).rejects.toMatchObject({
        code: gate === 'generation' || gate === 'expiry' ? 'VERSION_CONFLICT' : 'FORBIDDEN',
      })
      await capacityTransaction(fixture, async (transaction) => {
        expect(
          (
            await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id=$1', [
              fixture.otherDocumentId,
            ])
          ).rows,
        ).toEqual([])
        expect(
          (
            await transaction.query('SELECT id FROM pgboss.job_common WHERE name=$1', [
              fixture.policy.queueName,
            ])
          ).rows,
        ).toEqual([])
      })
    })
  },
)

it('binds size and format to the original persisted upload request hash', async () => {
  await withUploadCompletion(async (fixture) => {
    const input = {
      ...fixture.input,
      prepared: {
        ...fixture.input.prepared,
        staging: { ...fixture.input.prepared.staging, format: 'md' as const },
      },
      stored: { ...fixture.input.stored, format: 'md' as const, mimeType: 'text/markdown' },
    }
    await expect(
      capacityTransaction(fixture, (transaction) =>
        completeKnowledgeUpload(transaction, input, fixture.policy),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

it('rejects a half-bound upload job without weakening the completion pair constraint', async () => {
  await withUploadCompletion(async (fixture) => {
    await inRoleTransaction('bootstrap', undefined, async (client) => {
      await expect(
        client.query(
          'UPDATE knowledge.kb_operations SET upload_job_id=$3 WHERE owner_id=$1 AND id=$2',
          [fixture.owners[0], fixture.input.prepared.operation.id, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'kb_operations_upload_job_check' })
    })
  })
})

it('hash-checks the independent increment and refuses replay without rewriting receipts', async () => {
  const receiptPath = resolve(localDirectory, 'upload-completion-receipt.json')
  const before = await readFile(receiptPath, 'utf8')
  const receipt = JSON.parse(before) as {
    instanceId: string
    baseline: { name: string; sha256: string }[]
    artifacts: { name: string; sha256: string }[]
  }
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'drizzle/0006_upload_completion.sql',
    'security/upload-completion.sql',
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
        resolve(serviceDirectory, 'integration/apply-upload-completion-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the upload-completion migration'),
  })
  expect(await readFile(receiptPath, 'utf8')).toBe(before)
})
