import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  applyKnowledgeDeletionIntent,
  createFileDeletionJournal,
  createKnowledgeDeletionApplier,
  createKnowledgeReplayPrincipal,
  publishBuild,
  replayKnowledgeDeletionJournal,
} from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { publicationTransaction, withPublicationFixture } from './publication-fixtures'
import { inRoleTransaction } from './tenant-fixtures'
import { openLocalDatabase } from './local-database'

const replayAuthority = { issuer: 'https://synthetic.invalid', audience: 'local-knowledge' }

// 集成日志目录独立于单元测试夹具，避免与本机其他会话共享状态。
async function journalDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'fangoffice-deletion-replay-'))
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

type ReplayPublicationFixture = { owners: readonly string[]; id: string }

async function tombstoneCounts(fixture: ReplayPublicationFixture) {
  return inRoleTransaction('api', fixture.owners[0], async (client) => {
    const quota = await client.query(
      `SELECT active_files::text AS files, active_bytes::text AS bytes,
        active_chunks::text AS chunks, physical_accounted_bytes::text AS physical
        FROM knowledge.kb_quotas WHERE owner_id = $1`,
      [fixture.owners[0]],
    )
    const document = await client.query(
      `SELECT deleted_at IS NOT NULL AS deleted, active_build_id AS active,
        generation::text AS generation
        FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    const events = await client.query(
      `SELECT active_bytes_before::text AS before, active_bytes_after::text AS after
        FROM knowledge.kb_metering_events WHERE owner_id = $1 ORDER BY sequence`,
      [fixture.owners[0]],
    )
    return {
      quota: quota.rows[0],
      document: document.rows[0],
      events: events.rows.map((row) => row.after),
    }
  })
}

it('converges a journaled intent through the real tombstone and replays it idempotently after restart', async () => {
  await withPublicationFixture(async (fixture) => {
    const directory = await journalDirectory()
    const journal = await createFileDeletionJournal(directory)
    const intent = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      ownerId: fixture.owners[0],
      recordedAt: Date.now(),
      scope: { kind: 'document' as const, spaceId: fixture.id, documentId: fixture.id },
    }
    // 先日志后数据库：意图必须在任何数据库收敛之前持久化。
    await expect(journal.append(intent)).resolves.toEqual(intent)
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context))
    await capacityTransaction(fixture, async (transaction) => {
      await expect(applyKnowledgeDeletionIntent(transaction, intent)).resolves.toBe('DELETED')
    })
    expect(await tombstoneCounts(fixture)).toEqual({
      quota: { files: '0', bytes: '0', chunks: '0', physical: '16' },
      document: { deleted: true, active: null, generation: '2' },
      events: ['4', '0'],
    })
    // 模拟重启：从持久日志重放收敛，不复活对象、不追加计量事实。
    const { pool } = await openLocalDatabase('api')
    try {
      const reopened = await createFileDeletionJournal(directory)
      const applier = createKnowledgeDeletionApplier(
        pool,
        createKnowledgeReplayPrincipal(fixture.owners[0], replayAuthority),
      )
      await expect(replayKnowledgeDeletionJournal(reopened, applier)).resolves.toBe(1)
    } finally {
      await pool.end()
    }
    expect(await tombstoneCounts(fixture)).toEqual({
      quota: { files: '0', bytes: '0', chunks: '0', physical: '16' },
      document: { deleted: true, active: null, generation: '2' },
      events: ['4', '0'],
    })
  })
})

it('refuses replay convergence for an owner that does not own the scope and keeps the intent pending', async () => {
  await withPublicationFixture(async (fixture) => {
    const directory = await journalDirectory()
    const journal = await createFileDeletionJournal(directory)
    const intent = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      ownerId: fixture.owners[0],
      recordedAt: Date.now(),
      scope: { kind: 'document' as const, spaceId: fixture.id, documentId: fixture.id },
    }
    await expect(journal.append(intent)).resolves.toEqual(intent)
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context))
    await capacityTransaction(fixture, async (transaction) => {
      await expect(applyKnowledgeDeletionIntent(transaction, intent)).resolves.toBe('DELETED')
    })
    const { pool } = await openLocalDatabase('api')
    try {
      const reopened = await createFileDeletionJournal(directory)
      const stranger = createKnowledgeDeletionApplier(
        pool,
        createKnowledgeReplayPrincipal('synthetic-unrelated-owner', replayAuthority),
      )
      await expect(replayKnowledgeDeletionJournal(reopened, stranger)).rejects.toThrow(
        'SERVICE_UNAVAILABLE',
      )
    } finally {
      await pool.end()
    }
    // 非授权重放既不改墓碑也不清日志；意图仍在等待合法收敛。
    expect(await tombstoneCounts(fixture)).toEqual({
      quota: { files: '0', bytes: '0', chunks: '0', physical: '16' },
      document: { deleted: true, active: null, generation: '2' },
      events: ['4', '0'],
    })
    const entries: unknown[] = []
    const retained = await createFileDeletionJournal(directory)
    for await (const entry of retained.entries()) entries.push(entry)
    expect(entries).toHaveLength(1)
  })
})