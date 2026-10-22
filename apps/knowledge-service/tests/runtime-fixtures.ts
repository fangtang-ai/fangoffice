import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseKnowledgeRuntimeConfig } from '../src/runtime'

export const environment = {
  KNOWLEDGE_DATABASE_NAME: 'knowledge_synthetic',
  KNOWLEDGE_API_DATABASE_ROLE: 'knowledge_api',
  KNOWLEDGE_API_DATABASE_URL:
    'postgresql://knowledge_api:synthetic-pass@db.invalid:5432/knowledge_synthetic',
  KNOWLEDGE_WORKER_DATABASE_ROLE: 'knowledge_worker',
  KNOWLEDGE_WORKER_DATABASE_URL:
    'postgresql://knowledge_worker:synthetic-worker-pass@db.invalid:5432/knowledge_synthetic',
  KNOWLEDGE_MAINTENANCE_DATABASE_ROLE: 'knowledge_maintenance',
  KNOWLEDGE_MAINTENANCE_DATABASE_URL:
    'postgresql://knowledge_maintenance:synthetic-maintenance-pass@db.invalid:5432/knowledge_synthetic',
  KNOWLEDGE_QUEUE_NAME: 'knowledge_ingest',
  KNOWLEDGE_AUTH_ISSUER: 'https://issuer.invalid/oidc',
  KNOWLEDGE_AUTH_AUDIENCE: 'https://account.invalid',
  KNOWLEDGE_AUTH_REQUIRED_SCOPES: 'knowledge:access',
  KNOWLEDGE_DELETION_JOURNAL_DIR: join(tmpdir(), 'fangoffice-deletion-journal-synthetic'),
}

export function apiConfig(overrides: Record<string, string> = {}) {
  const config = parseKnowledgeRuntimeConfig({ ...environment, ...overrides }, 'api')
  if (config.role !== 'api') throw new Error('expected API configuration')
  return config
}
