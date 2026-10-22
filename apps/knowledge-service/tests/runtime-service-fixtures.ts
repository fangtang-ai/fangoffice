import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { KnowledgeDatabasePool } from '../src/runtime'
import { transactionFixture } from './runtime-transaction-fixtures'
import { apiConfig } from './runtime-fixtures'

let syntheticJournalCounter = 0

// 每个服务 fixture 用独立日志目录，避免跨用例重放历史意图。
export function syntheticDeletionJournalDirectory() {
  syntheticJournalCounter += 1
  return join(tmpdir(), `fangoffice-api-journal-${process.pid}-${Date.now()}-${syntheticJournalCounter}`)
}

export function syntheticPool(role = 'knowledge_api') {
  return {
    connect: vi.fn(async () => {
      throw new Error('No synthetic transaction configured')
    }),
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

export function localApiConfig(overrides: Record<string, string> = {}) {
  return apiConfig({
    KNOWLEDGE_ENVIRONMENT: 'isolated_test',
    KNOWLEDGE_API_DATABASE_URL:
      'postgresql://knowledge_api:synthetic-pass@127.0.0.1:5432/knowledge_synthetic',
    KNOWLEDGE_API_PORT: '0',
    ...overrides,
  })
}

// 合成池但事务检出走真实事务夹具客户端：供 HTTP 删除/启动重放用例复用。
export function transactionalServicePool(role = 'knowledge_api') {
  const { client } = transactionFixture()
  const pool = syntheticPool(role)
  pool.connect = vi.fn(async () => client as unknown as Awaited<ReturnType<typeof pool.connect>>)
  return { pool, client }
}
