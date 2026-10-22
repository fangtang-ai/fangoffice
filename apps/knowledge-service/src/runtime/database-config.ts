import { deny } from '../errors'
import { isLoopback, port, setting, type KnowledgeEnvironment } from './config-values'

export function dedicatedDatabase(
  env: KnowledgeEnvironment,
  role: 'api' | 'worker' | 'maintenance',
  isolated: boolean,
) {
  const database = setting(env.KNOWLEDGE_DATABASE_NAME, 63)
  const user = setting(env[`KNOWLEDGE_${role.toUpperCase()}_DATABASE_ROLE`], 63)
  const raw = setting(env[`KNOWLEDGE_${role.toUpperCase()}_DATABASE_URL`], 4096)
  const url = new URL(raw)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.search ||
    url.hash ||
    !/^[a-z_][a-z0-9_]*$/.test(database) ||
    !/^[a-z_][a-z0-9_]*$/.test(user) ||
    decodeURIComponent(url.pathname.slice(1)) !== database ||
    decodeURIComponent(url.username) !== user ||
    !url.password
  )
    deny('NOT_CONFIGURED')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isolated && !isLoopback(host)) deny('NOT_CONFIGURED')
  // Supply every connection target explicitly; pg's generic PG* environment must not choose the database.
  return Object.freeze({
    host,
    port: port(url.port || '5432', false),
    database,
    user,
    password: decodeURIComponent(url.password),
    ssl: isolated ? (false as const) : { rejectUnauthorized: true },
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    query_timeout: 5000,
    application_name: `fangtang-knowledge-${role}`,
    options: '-c statement_timeout=5000 -c idle_in_transaction_session_timeout=5000',
  })
}
