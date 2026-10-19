import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  localDirectory,
  openLocalDatabase,
  serviceDirectory,
  tenantTables,
} from './local-database.ts'

export async function applyLocalGate(label, guard, prerequisites = [], schemaFiles = []) {
  const { pool: admin, settings } = await openLocalDatabase('bootstrap')
  try {
    const receipt = JSON.parse(
      await readFile(resolve(localDirectory, 'bootstrap-receipt.json'), 'utf8'),
    )
    const identity = await admin.query(
      'SELECT system_identifier::text AS identifier FROM pg_control_system()',
    )
    if (
      receipt.instanceId !== settings.instanceId ||
      receipt.systemIdentifier !== identity.rows[0]?.identifier
    )
      throw new Error('Refusing an unrelated cluster')
  } finally {
    await admin.end()
  }

  const baseline = JSON.parse(
    await readFile(resolve(localDirectory, 'migration-receipt.json'), 'utf8'),
  )
  const files = [
    'drizzle/0000_knowledge_base.sql',
    'security/force-rls.sql',
    'security/local-grants.sql',
  ]
  if (baseline.instanceId !== settings.instanceId || baseline.artifacts.length !== files.length)
    throw new Error('Refusing an unrecognized migration baseline')
  const artifacts = [...baseline.artifacts]
  for (const [index, name] of files.entries()) {
    if (baseline.artifacts[index]?.name !== name)
      throw new Error('Refusing a changed migration baseline')
  }
  for (const prerequisite of prerequisites) {
    const receipt = JSON.parse(
      await readFile(resolve(localDirectory, `${prerequisite}-receipt.json`), 'utf8'),
    )
    if (
      receipt.instanceId !== settings.instanceId ||
      receipt.artifacts.length < 1 ||
      receipt.artifacts.at(-1)?.name !== `security/${prerequisite}.sql` ||
      receipt.artifacts
        .slice(0, -1)
        .some((artifact) => !/^drizzle\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(artifact.name)) ||
      JSON.stringify(receipt.baseline) !== JSON.stringify(artifacts)
    )
      throw new Error('Refusing an unrecognized prerequisite gate receipt')
    artifacts.push(...receipt.artifacts)
  }
  for (const artifact of artifacts) {
    const sha256 = createHash('sha256')
      .update(await readFile(resolve(serviceDirectory, artifact.name)))
      .digest('hex')
    if (artifact.sha256 !== sha256) throw new Error('Refusing a changed migration baseline')
  }

  if (schemaFiles.some((name) => !/^drizzle\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(name)))
    throw new Error('Refusing an unexpected schema increment path')
  const supplements = await Promise.all(
    [...schemaFiles, `security/${label}.sql`].map(async (name) => {
      const sql = await readFile(resolve(serviceDirectory, name), 'utf8')
      return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') }
    }),
  )
  const { pool } = await openLocalDatabase('migrator')
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Baseline/replay checks and gate DDL share one serialized migration transaction.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('knowledge:local-gates', 0))",
      )
      // 新函数按签名防重放；纯ACL授予/撤销按变更前权限防重放，不造标记函数。
      const existing =
        typeof guard === 'string'
          ? await client.query('SELECT to_regprocedure($1) AS existing', [guard])
          : 'column' in guard
            ? await client.query("SELECT has_column_privilege($1, $2, $3, 'UPDATE') AS existing", [
                guard.role,
                guard.table,
                guard.column,
              ])
            : await client.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS existing", [
                guard.role,
                guard.signature,
              ])
      if (
        typeof guard === 'string'
          ? existing.rows[0]?.existing !== null
          : existing.rows[0]?.existing !== 'column' in guard
      )
        throw new Error(`Refusing to replay the ${label} migration`)
      const tables = await client.query(`SELECT relname::text, relrowsecurity, relforcerowsecurity,
        pg_get_userbyid(relowner) AS owner FROM pg_class
        WHERE relnamespace = 'knowledge'::regnamespace AND relkind = 'r' ORDER BY relname`)
      const expected = [...tenantTables, 'kb_index_profiles'].sort()
      if (
        tables.rows.length !== expected.length ||
        !tables.rows.every(
          (table, index) =>
            table.relname === expected[index] &&
            table.owner === 'knowledge_migrator' &&
            table.relrowsecurity === (table.relname !== 'kb_index_profiles') &&
            table.relforcerowsecurity === (table.relname !== 'kb_index_profiles'),
        )
      )
        throw new Error('Refusing an unexpected schema security baseline')
      // 生成的列/约束增量和依赖它的窄函数必须一起提交，避免半套准入协议。
      for (const supplement of supplements) await client.query(supplement.sql)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
  await writeFile(
    resolve(localDirectory, `${label}-receipt.json`),
    JSON.stringify(
      {
        purpose: settings.purpose,
        instanceId: settings.instanceId,
        appliedAt: new Date().toISOString(),
        baseline: artifacts,
        artifacts: supplements.map(({ name, sha256 }) => ({ name, sha256 })),
      },
      null,
      2,
    ),
  )
  console.log(`Applied ${label} local supplement atomically.`)
}
