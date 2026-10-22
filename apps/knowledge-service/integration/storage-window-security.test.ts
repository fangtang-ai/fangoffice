import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { closeStorageWindow } from '../src/runtime'
import { capacityTransaction, changeCapacityFixture } from './capacity-fixtures'
import { localDirectory, localSettings, roleNames, serviceDirectory } from './local-database'
import {
  closeStorageSql,
  storageState,
  storageWindow,
  withStorageWindowFixture,
} from './storage-window-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

const signature = 'knowledge.close_storage_window(uuid,timestamptz,timestamptz,text)'

it('preserves the applied SQL/index hash chain and refuses migration replay', async () => {
  const path = resolve(localDirectory, 'storage-window-receipt.json')
  const before = await readFile(path, 'utf8')
  const receipt = JSON.parse(before) as {
    instanceId: string
    baseline: { name: string; sha256: string }[]
    artifacts: { name: string; sha256: string }[]
  }
  expect(receipt.instanceId).toBe((await localSettings()).instanceId)
  expect(receipt.artifacts.map((artifact) => artifact.name)).toEqual([
    'drizzle/0003_storage_window.sql',
    'security/storage-window.sql',
  ])
  for (const artifact of [...receipt.baseline, ...receipt.artifacts]) {
    expect(
      createHash('sha256')
        .update(await readFile(resolve(serviceDirectory, artifact.name)))
        .digest('hex'),
    ).toBe(artifact.sha256)
  }
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(serviceDirectory, 'integration/apply-storage-window-local.mjs'),
      ],
      { windowsHide: true, timeout: 15000 },
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Refusing to replay the storage-window migration'),
  })
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('keeps the window definer worker-only and leaves direct metering inserts denied', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    const { rows } = await client.query(
      `SELECT procedure.prosecdef AS definer, procedure.proconfig AS config,
              role.rolname::text AS owner, role.rolsuper AS superuser, role.rolbypassrls AS bypass,
              EXISTS (SELECT 1 FROM aclexplode(procedure.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
         FROM pg_proc procedure JOIN pg_roles role ON role.oid = procedure.proowner
        WHERE procedure.oid = $1::regprocedure`,
      [signature],
    )
    expect(rows).toEqual([
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
          await client.query(
            `SELECT has_function_privilege($1, $2, 'EXECUTE') AS execute,
                has_any_column_privilege($1, 'knowledge.kb_metering_events', 'INSERT') AS insert`,
            [roleNames[role], signature],
          )
        ).rows,
      ).toEqual([{ execute: role === 'worker', insert: false }])
    }
  })
})

it.each(['api', 'gc'] as const)('denies direct window execution by %s', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query('SELECT knowledge.close_storage_window(NULL, NULL, NULL, NULL)'),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('requires a trusted owner and does not replay another owner window', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await inRoleTransaction('worker', undefined, async (client) => {
      expect(
        (
          await client.query(
            'SELECT knowledge.close_storage_window(NULL, NULL, NULL, NULL) AS status',
          )
        ).rows,
      ).toEqual([{ status: 'UNAUTHENTICATED' }])
    })
    const request = storageWindow()
    await expect(closeStorageSql(fixture, request)).resolves.toBe('CLOSED')
    await expect(
      capacityTransaction(
        fixture,
        (transaction) => closeStorageWindow(transaction, request),
        'synthetic-missing-owner',
        'worker',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await storageState(fixture, fixture.owners[1])).toEqual([])
    await expect(closeStorageSql(fixture, request, fixture.owners[1])).resolves.toBe('CLOSED')
    expect(await storageState(fixture)).toHaveLength(1)
    expect(await storageState(fixture, fixture.owners[1])).toHaveLength(1)
  })
})

it.each(['frozen', 'closed'])(
  'still accounts accrued storage for an owner that is %s',
  async (state) => {
    await withStorageWindowFixture(async (fixture) => {
      await changeCapacityFixture(
        fixture,
        'UPDATE knowledge.kb_quotas SET owner_state = $2 WHERE owner_id = $1',
        [state],
      )
      await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('CLOSED')
      expect(await storageState(fixture)).toMatchObject([{ quantity: '345600000' }])
    })
  },
)

it('keeps a closed observation immutable even to the bootstrap role', async () => {
  await withStorageWindowFixture(async (fixture) => {
    const request = storageWindow()
    await expect(closeStorageSql(fixture, request)).resolves.toBe('CLOSED')
    await expect(
      inRoleTransaction('bootstrap', undefined, async (client) => {
        await client.query(
          'UPDATE knowledge.kb_metering_events SET quantity = 0 WHERE owner_id = $1 AND id = $2',
          [fixture.owners[0], request.windowId],
        )
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
    expect(await storageState(fixture)).toMatchObject([{ quantity: '345600000' }])
  })
})
