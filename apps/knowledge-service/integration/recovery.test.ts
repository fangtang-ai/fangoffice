import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import { expect, it } from 'vitest'
import { localDirectory, openLocalDatabase, tenantTables } from './local-database'
import { verifyRestoredCapacity } from './recovery-capacity'
import { verifyRestoredPublication } from './recovery-publication'
import { removeTenants, seedTenants } from './tenant-fixtures'

const run = promisify(execFile)
const restoreDatabase = 'knowledge_isolated_restore'

async function removeRestoredDatabase(source: Pool, instanceId: string) {
  const marker = await source.query<{ marker: string }>(
    `SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1`,
    [restoreDatabase],
  )
  if (marker.rows[0]?.marker !== `fangoffice-knowledge-isolated:${instanceId}:restore`)
    throw new Error('Refusing cleanup of an unrecognized restore database')
  await source.query('DROP DATABASE knowledge_isolated_restore')
}

async function fingerprint(pool: Pool) {
  const tables = []
  for (const table of [...tenantTables, 'kb_index_profiles']) {
    const result = await pool.query<{ count: string; hash: string }>(`
      SELECT count(*)::text AS count, md5(COALESCE(string_agg(to_jsonb(entry)::text,
      E'\n' ORDER BY to_jsonb(entry)::text), '')) AS hash FROM knowledge.${table} entry`)
    tables.push({ name: table, ...result.rows[0] })
  }
  const security = await pool.query(`SELECT relname, relrowsecurity, relforcerowsecurity,
    pg_get_userbyid(relowner) AS owner FROM pg_class
    WHERE relnamespace = 'knowledge'::regnamespace AND relkind = 'r' ORDER BY relname`)
  const policies = await pool.query(`SELECT tablename, policyname, permissive, qual, with_check
    FROM pg_policies WHERE schemaname = 'knowledge' ORDER BY tablename, policyname`)
  const grants = await pool.query(`SELECT grantee, table_name, column_name, privilege_type
    FROM information_schema.column_privileges WHERE table_schema = 'knowledge'
    AND grantee IN ('knowledge_api', 'knowledge_worker', 'knowledge_gc')
    ORDER BY grantee, table_name, column_name, privilege_type`)
  const triggers = await pool.query(`SELECT relation.relname, trigger.tgname,
    trigger.tgenabled, pg_get_triggerdef(trigger.oid) AS definition
    FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
    WHERE relation.relnamespace = 'knowledge'::regnamespace AND NOT trigger.tgisinternal
    ORDER BY relation.relname, trigger.tgname`)
  const functions = await pool.query(`SELECT proname, pg_get_functiondef(oid) AS definition,
    pg_get_userbyid(proowner) AS owner, proacl::text AS acl
    FROM pg_proc WHERE pronamespace = 'knowledge'::regnamespace ORDER BY proname`)
  return {
    tables,
    security: security.rows,
    policies: policies.rows,
    grants: grants.rows,
    triggers: triggers.rows,
    functions: functions.rows,
  }
}

it('restores a real custom-format backup into a new marked local database with data, ownership and security intact', async () => {
  const fixture = await seedTenants('recovery')
  const { pool: source, settings } = await openLocalDatabase('bootstrap')
  let created = false
  let restored: Pool | undefined
  let runtime: Pool | undefined
  const backupDirectory = resolve(localDirectory, 'backups')
  const dump = resolve(backupDirectory, `knowledge-${Date.now()}.dump`)
  try {
    const existing = await source.query('SELECT datname FROM pg_database WHERE datname = $1', [
      restoreDatabase,
    ])
    expect(existing.rows, 'refuses to overwrite an existing restore database').toEqual([])
    const expected = await fingerprint(source)
    await mkdir(backupDirectory, { recursive: true })
    const environment = {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PGPASSWORD: settings.roles.bootstrap.password,
      PGSSLMODE: 'disable',
      PGCONNECT_TIMEOUT: '5',
    }
    const connection = ['--host=127.0.0.1', '--port=55432', '--username=knowledge_bootstrap']
    await run(
      resolve(localDirectory, 'runtime/bin/pg_dump.exe'),
      [...connection, '--format=custom', `--file=${dump}`, '--dbname=knowledge_isolated'],
      { env: environment, windowsHide: true, timeout: 30000 },
    )
    await source.query('CREATE DATABASE knowledge_isolated_restore OWNER knowledge_migrator')
    created = true
    await source.query(`COMMENT ON DATABASE knowledge_isolated_restore IS
      'fangoffice-knowledge-isolated:${settings.instanceId}:restore'`)
    await run(
      resolve(localDirectory, 'runtime/bin/pg_restore.exe'),
      [
        ...connection,
        '--single-transaction',
        '--exit-on-error',
        '--dbname=knowledge_isolated_restore',
        dump,
      ],
      { env: environment, windowsHide: true, timeout: 30000 },
    )
    restored = (await openLocalDatabase('bootstrap', 'restore')).pool
    expect(await fingerprint(restored)).toEqual(expected)
    expect(await fingerprint(source)).toEqual(expected)
    expect(expected.triggers).toHaveLength(15)
    expect(expected.functions).toHaveLength(16)
    await restored.query('BEGIN')
    await expect(
      restored.query(
        `UPDATE knowledge.kb_versions SET oss_key = 'restore-tampering'
      WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
    await restored.query('ROLLBACK')
    await restored.query('BEGIN')
    await restored.query(
      `UPDATE knowledge.kb_builds SET status = 'sealed', sealed_at = now(),
      manifest = '{}', manifest_hash = decode(repeat('ab', 32), 'hex')
      WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await expect(
      restored.query(
        `INSERT INTO knowledge.kb_source_units
      SELECT (jsonb_populate_record(NULL::knowledge.kb_source_units, to_jsonb(sample) ||
        jsonb_build_object('id', gen_random_uuid(), 'ordinal', 1))).*
      FROM knowledge.kb_source_units sample WHERE owner_id = $1 AND build_id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_writable' })
    await restored.query('ROLLBACK')
    runtime = (await openLocalDatabase('api', 'restore')).pool
    await runtime.query('BEGIN')
    await runtime.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
    expect((await runtime.query('SELECT owner_id FROM knowledge.kb_quotas')).rows).toEqual([
      { owner_id: fixture.owners[0] },
    ])
    await runtime.query('ROLLBACK')
    await verifyRestoredCapacity(restored, runtime, fixture)
    await verifyRestoredPublication()
    await writeFile(
      resolve(localDirectory, 'recovery-receipt.json'),
      JSON.stringify(
        {
          instanceId: settings.instanceId,
          completedAt: new Date().toISOString(),
          dump,
          sha256: createHash('sha256')
            .update(await readFile(dump))
            .digest('hex'),
          tables: expected.tables,
          security: expected.security,
          policies: expected.policies.length,
          columnGrants: expected.grants.length,
          runtimeRls: true,
          triggers: expected.triggers,
          functions: expected.functions,
          immutableFacts: true,
          buildContentGates: true,
          capacityAdmission: true,
          replacementAdmission: true,
          capacityCancellation: true,
          retryAdmission: true,
          capacityPublication: true,
        },
        null,
        2,
      ),
    )
  } finally {
    await runtime?.end()
    await restored?.end()
    try {
      if (created) await removeRestoredDatabase(source, settings.instanceId)
    } finally {
      await source.end()
      await removeTenants(fixture)
    }
  }
}, 60000)
