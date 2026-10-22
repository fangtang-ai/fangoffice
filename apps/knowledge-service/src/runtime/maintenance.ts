import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { deny, KnowledgePolicyError } from '../errors'
import type { KnowledgeDatabasePool } from './database'
import type { KnowledgeMaintenanceConfig } from './maintenance-config'
import {
  openKnowledgeDatabase,
  shutdownTimeout,
  withinShutdown,
  type KnowledgeServiceOptions,
} from './lifecycle'

export async function maintainKnowledgeQueue(
  config: KnowledgeMaintenanceConfig,
  options: KnowledgeServiceOptions = {},
) {
  let pool: KnowledgeDatabasePool | undefined
  const database = await openKnowledgeDatabase(config, {
    ...options,
    poolFactory(settings) {
      pool = options.poolFactory ? options.poolFactory(settings) : new Pool(settings)
      return pool
    },
  })
  try {
    if (!pool) deny('SERVICE_UNAVAILABLE')
    const verifiedPool = pool
    let failed = false
    const boss = new PgBoss({
      schema: 'pgboss',
      db: {
        executeSql: (statement, values) => {
          if (options.signal?.aborted) deny('CANCELLED')
          if (database.signal.aborted) deny('SERVICE_UNAVAILABLE')
          return verifiedPool.query(statement, values)
        },
      },
      createSchema: false,
      migrate: false,
      supervise: false,
      schedule: false,
      registerInstance: false,
      persistQueueStats: false,
      persistWarnings: false,
      monitorVacuum: false,
      reindex: false,
    })
    boss.on('error', () => {
      failed = true
    })
    if (!(await boss.getQueue(config.queueName))) deny('NOT_FOUND')
    // 独立维护身份执行单次指定队列恢复；不启动任何注册、调度或DDL定时器。
    await boss.supervise(config.queueName, { reindex: false })
    if (options.signal?.aborted) deny('CANCELLED')
    if (failed || database.signal.aborted) deny('SERVICE_UNAVAILABLE')
  } catch (error) {
    if (error instanceof KnowledgePolicyError) throw error
    deny('SERVICE_UNAVAILABLE')
  } finally {
    await withinShutdown(() => database.close(), shutdownTimeout(options))
  }
}
