import { readFile, realpath } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

export const localDirectory = fileURLToPath(
  new URL('../../../tmp/knowledge-pg-isolated/', import.meta.url),
)
export const roleNames = {
  bootstrap: 'knowledge_bootstrap',
  migrator: 'knowledge_migrator',
  api: 'knowledge_api',
  worker: 'knowledge_worker',
  gc: 'knowledge_gc',
} as const
export type LocalRole = keyof typeof roleNames

export const tenantTables = [
  'kb_billing_receipts',
  'kb_builds',
  'kb_chunk_embeddings',
  'kb_chunk_sources',
  'kb_chunks',
  'kb_documents',
  'kb_evidence_items',
  'kb_evidence_manifests',
  'kb_metering_events',
  'kb_operations',
  'kb_quotas',
  'kb_reservations',
  'kb_source_units',
  'kb_spaces',
  'kb_versions',
] as const

export async function localSettings() {
  const settings = JSON.parse(
    await readFile(resolve(localDirectory, 'connection.json'), 'utf8'),
  ) as {
    purpose: string
    instanceId: string
    root: string
    host: string
    port: number
    database: string
    roles: Record<LocalRole, { user: string; password: string }>
  }
  if (
    settings.purpose !== 'fangoffice-knowledge-isolated' ||
    settings.host !== '127.0.0.1' ||
    settings.port !== 55432 ||
    settings.database !== 'knowledge_isolated' ||
    !/^[0-9a-f-]{36}$/.test(settings.instanceId) ||
    relative(await realpath(localDirectory), await realpath(settings.root)) !== '' ||
    !Object.entries(roleNames).every(([role, user]) => {
      const credential = settings.roles[role as LocalRole]
      return credential?.user === user && /^[0-9a-f]{64}$/.test(credential.password)
    })
  )
    throw new Error('Refusing an unrecognized local knowledge database target')
  return settings
}

export async function openLocalDatabase(
  role: LocalRole,
  target: 'primary' | 'restore' = 'primary',
) {
  const settings = await localSettings()
  const database = target === 'restore' ? 'knowledge_isolated_restore' : settings.database
  const marker = `fangoffice-knowledge-isolated:${settings.instanceId}${target === 'restore' ? ':restore' : ''}`
  const pool = new Pool({
    host: '127.0.0.1',
    port: 55432,
    database,
    user: settings.roles[role].user,
    password: settings.roles[role].password,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000,
    application_name: 'fangoffice-local-knowledge-test',
    options:
      '-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000',
  })
  pool.on('error', () => {})
  try {
    const result = await pool.query<{ database: string; user: string; marker: string }>(`
      SELECT current_database() AS database, current_user AS user,
      shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database') AS marker`)
    if (
      result.rows.length !== 1 ||
      result.rows[0]?.database !== database ||
      result.rows[0]?.user !== settings.roles[role].user ||
      result.rows[0]?.marker !== marker
    )
      throw new Error('Refusing a database without the local isolation marker')
    return { pool, settings }
  } catch (error) {
    await pool.end()
    throw error
  }
}

export const serviceDirectory = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
