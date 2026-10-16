import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { localDirectory, openLocalDatabase, serviceDirectory } from './local-database.ts'

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

const files = [
  'drizzle/0000_knowledge_base.sql',
  'security/force-rls.sql',
  'security/local-grants.sql',
]
const artifacts = await Promise.all(
  files.map(async (name) => {
    const sql = await readFile(resolve(serviceDirectory, name), 'utf8')
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') }
  }),
)
const { pool } = await openLocalDatabase('migrator')
const client = await pool.connect()
try {
  await client.query('BEGIN')
  const schema = await client.query("SELECT to_regnamespace('knowledge') AS existing")
  if (schema.rows[0]?.existing !== null)
    throw new Error('Refusing to overwrite an existing knowledge schema')
  for (const artifact of artifacts) await client.query(artifact.sql)
  await client.query('COMMIT')
  await writeFile(
    resolve(localDirectory, 'migration-receipt.json'),
    JSON.stringify(
      {
        purpose: settings.purpose,
        instanceId: settings.instanceId,
        appliedAt: new Date().toISOString(),
        artifacts: artifacts.map(({ name, sha256 }) => ({ name, sha256 })),
      },
      null,
      2,
    ),
  )
  console.log('Applied candidate, FORCE and restricted local-only grants atomically.')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}
