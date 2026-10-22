import { deny } from '../errors'
import { dedicatedDatabase } from './database-config'
import { setting, type KnowledgeEnvironment } from './config-values'

export function parseKnowledgeMaintenanceConfig(env: KnowledgeEnvironment) {
  try {
    const environment = env.KNOWLEDGE_ENVIRONMENT ?? 'production'
    if (environment !== 'production' && environment !== 'isolated_test') deny('NOT_CONFIGURED')
    const queueName = setting(env.KNOWLEDGE_QUEUE_NAME, 63)
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(queueName)) deny('NOT_CONFIGURED')
    return Object.freeze({
      role: 'maintenance' as const,
      environment,
      queueName,
      database: dedicatedDatabase(env, 'maintenance', environment === 'isolated_test'),
    })
  } catch {
    deny('NOT_CONFIGURED')
  }
}

export type KnowledgeMaintenanceConfig = ReturnType<typeof parseKnowledgeMaintenanceConfig>
