import { expect, it, vi } from 'vitest'
import {
  createFileDeletionJournal,
  startKnowledgeApi,
  type KnowledgeDatabasePool,
} from '../src/runtime'
import { collectDeletionIntents, deletionIntent, deletionJournalDirectory } from './deletion-journal-fixtures'
import { localApiConfig, transactionalServicePool } from './runtime-service-fixtures'
import { accessToken, publicKeySet } from './runtime-auth-fixtures'
import { now } from './fixtures'

// 启动重放与 HTTP 删除共用同一配置面，这里只关注监听前的收敛行为。
function replayService(directory: string, pool: KnowledgeDatabasePool) {
  return startKnowledgeApi(localApiConfig({ KNOWLEDGE_DELETION_JOURNAL_DIR: directory }), {
    poolFactory: () => pool,
    authentication: { fetch: vi.fn(async () => Response.json(publicKeySet)), now: () => now },
    shutdownTimeoutMs: 100,
  })
}

function replayPool(applies: 'REPLAY' | 'PENDING' | 'BROKEN') {
  const { pool, client } = transactionalServicePool()
  client.query.mockImplementation(async (statement: string) =>
    statement.startsWith('SELECT knowledge.apply_deletion_intent')
      ? applies === 'BROKEN'
        ? { rows: [{}], rowCount: 1 }
        : { rows: [{ status: applies }], rowCount: 1 }
      : { rows: [{ owner_id: null }], rowCount: 1 },
  )
  return { pool, client }
}

it('replays every recorded intent against PostgreSQL before the service listens', async () => {
  const directory = await deletionJournalDirectory()
  const journal = await createFileDeletionJournal(directory)
  await journal.append(deletionIntent)
  const { pool } = replayPool('REPLAY')
  const service = await replayService(directory, pool)
  try {
    expect(typeof service.origin).toBe('string')
  } finally {
    await service.close()
  }
})

it('allows deferred (PENDING) convergence but refuses readiness on an unusable applier outcome', async () => {
  const directory = await deletionJournalDirectory()
  const journal = await createFileDeletionJournal(directory)
  await journal.append(deletionIntent)
  const deferred = await replayService(directory, replayPool('PENDING').pool)
  await deferred.close()
  // 无法收敛的意图必须拒绝就绪，绝不假报已删除。
  await expect(replayService(directory, replayPool('BROKEN').pool)).rejects.toThrow(
    'SERVICE_UNAVAILABLE',
  )
  // 第二次启动面对同一条未收敛意图仍然拒绝。
  await expect(replayService(directory, replayPool('BROKEN').pool)).rejects.toThrow(
    'SERVICE_UNAVAILABLE',
  )
  // 意图必须仍在持久日志中等待下一次成功重放。
  const reopened = await createFileDeletionJournal(directory)
  expect(await collectDeletionIntents(reopened)).toEqual([deletionIntent])
})

it('holds its journal directory even when the deployment has not created it', async () => {
  const directory = `${await deletionJournalDirectory()}/not-created/nested`
  const service = await replayService(directory, replayPool('REPLAY').pool)
  try {
    const reopened = await createFileDeletionJournal(directory)
    expect(await collectDeletionIntents(reopened)).toEqual([])
  } finally {
    await service.close()
  }
})