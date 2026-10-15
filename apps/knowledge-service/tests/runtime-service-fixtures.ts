import { vi } from 'vitest'
import type { KnowledgeDatabasePool } from '../src/runtime'
import { apiConfig } from './runtime-fixtures'

export function syntheticPool(role = 'knowledge_api') {
  return {
    query: vi.fn(async (_sql: string) => ({
      rows: [
        {
          database: 'knowledge_synthetic',
          role,
          session_role: role,
          superuser: false,
          bypass_rls: false,
          create_role: false,
          create_database: false,
          replication: false,
        },
      ],
    })),
    end: vi.fn(async () => {}),
    on: vi.fn<KnowledgeDatabasePool['on']>(),
  }
}

export function localApiConfig() {
  return apiConfig({
    KNOWLEDGE_ENVIRONMENT: 'isolated_test',
    KNOWLEDGE_API_DATABASE_URL:
      'postgresql://knowledge_api:synthetic-pass@127.0.0.1:5432/knowledge_synthetic',
    KNOWLEDGE_API_PORT: '0',
  })
}
