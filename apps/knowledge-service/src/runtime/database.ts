import { Pool } from 'pg'
import { deny, KnowledgePolicyError } from '../errors'
import type { KnowledgeRuntimeConfig } from './config'
import type { KnowledgePrincipal } from '../identity'
import { createKnowledgeQueue } from './queue'
import {
  withKnowledgeTransaction,
  type KnowledgeTransaction,
  type KnowledgeTransactionPool,
} from './transaction'

export interface KnowledgeDatabasePool extends KnowledgeTransactionPool {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
  end: () => Promise<void>
  on: (event: 'error', listener: () => void) => unknown
}

export function createKnowledgeDatabase(
  config: KnowledgeRuntimeConfig['database'],
  factory: (config: KnowledgeRuntimeConfig['database']) => KnowledgeDatabasePool = (settings) =>
    new Pool(settings),
) {
  const failure = new AbortController()
  let closed = false
  let verified = false
  let closing: Promise<void> | undefined
  let pool: KnowledgeDatabasePool
  try {
    pool = factory(config)
  } catch {
    deny('SERVICE_UNAVAILABLE')
  }
  pool.on('error', () => {
    verified = false
    failure.abort()
  })
  const healthy = () => verified && !closed && !failure.signal.aborted
  return {
    signal: failure.signal,
    healthy,
    queue(name: string) {
      if (!healthy()) deny('SERVICE_UNAVAILABLE')
      return createKnowledgeQueue(
        {
          async query(statement, values) {
            // 巡检可与轮询并行；已验证身份仅在连接失败或关闭后失效。
            if (closed || failure.signal.aborted) deny('SERVICE_UNAVAILABLE')
            return pool.query(statement, values)
          },
        },
        name,
      )
    },
    async transaction<Result>(
      principal: KnowledgePrincipal,
      work: (transaction: KnowledgeTransaction) => Promise<Result>,
      { now }: { now?: () => number } = {},
    ) {
      if (!healthy()) deny('SERVICE_UNAVAILABLE')
      return withKnowledgeTransaction(
        pool,
        principal,
        async (transaction) => {
          if (!healthy()) deny('SERVICE_UNAVAILABLE')
          const result = await work(transaction)
          if (!healthy()) deny('SERVICE_UNAVAILABLE')
          return result
        },
        { now },
      )
    },
    async verify() {
      if (closed || failure.signal.aborted) deny('SERVICE_UNAVAILABLE')
      verified = false
      try {
        // Bind the actual session to the dedicated database and unprivileged role before listening.
        const result =
          await pool.query(`SELECT current_database() AS database, current_user AS role,
          session_user AS session_role, rolsuper AS superuser, rolbypassrls AS bypass_rls,
          rolcreaterole AS create_role, rolcreatedb AS create_database, rolreplication AS replication
          FROM pg_catalog.pg_roles WHERE rolname = current_user`)
        if (closed || failure.signal.aborted) deny('SERVICE_UNAVAILABLE')
        const identity = result.rows[0]
        if (
          result.rows.length !== 1 ||
          typeof identity !== 'object' ||
          identity === null ||
          !('database' in identity) ||
          identity.database !== config.database ||
          !('role' in identity) ||
          identity.role !== config.user ||
          !('session_role' in identity) ||
          identity.session_role !== config.user ||
          !['superuser', 'bypass_rls', 'create_role', 'create_database', 'replication'].every(
            (flag) => flag in identity && Reflect.get(identity, flag) === false,
          )
        )
          deny('NOT_CONFIGURED')
        verified = true
      } catch (error) {
        failure.abort()
        if (error instanceof KnowledgePolicyError) throw error
        deny('SERVICE_UNAVAILABLE')
      }
    },
    close() {
      closed = true
      verified = false
      failure.abort()
      closing ??= Promise.resolve()
        .then(() => pool.end())
        .catch(() => deny('SERVICE_UNAVAILABLE'))
      return closing
    },
  }
}

export type KnowledgeDatabase = ReturnType<typeof createKnowledgeDatabase>
