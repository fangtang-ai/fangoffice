import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createKnowledgePrincipal } from '../src/identity'
import {
  createFileDeletionJournal, createKnowledgeDeletionApplier, publishBuild,
} from '../src/runtime'
import { openLocalDatabase } from './local-database'
import { publicationTransaction, withPublicationFixture } from './publication-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

function principal(owner: string) {
  const now = Date.now()
  return createKnowledgePrincipal(
    {
      issuer: 'https://synthetic.invalid',
      audiences: ['local-knowledge'],
      subject: owner,
      expiresAt: now + 60000,
      permissions: [],
    },
    { issuer: 'https://synthetic.invalid', audience: 'local-knowledge' },
    now,
  )
}

async function withJournal(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'kb-deletion-journal-'))
  try {
    await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it('applies a journaled intent through the real tombstone and converges on replay', async () => {
  await withPublicationFixture(async (fixture) => {
    const owner = fixture.owners[0]
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context))
    await withJournal(async (directory) => {
      const journal = await createFileDeletionJournal(directory)
      const recorded = await journal.append({
        schemaVersion: 1, id: randomUUID(), ownerId: owner,
        scope: { kind: 'document', spaceId: fixture.id, documentId: fixture.id },
        recordedAt: Date.now(),
      })
      const { pool } = await openLocalDatabase('api')
      try {
        const apply = createKnowledgeDeletionApplier(pool, principal(owner))
        expect(await apply(recorded)).toBe('DELETED')
        // 幂等重放：同一意图再次应用仍收敛，不复活、不重复计费。
        expect(await apply(recorded)).toBe('DELETED')
        await inRoleTransaction('api', owner, async (client) => {
          expect((await client.query(`SELECT active_files::text AS files, active_bytes::text AS bytes,
            physical_accounted_bytes::text AS physical
            FROM knowledge.kb_quotas WHERE owner_id = $1`, [owner])).rows)
            .toEqual([{ files: '0', bytes: '0', physical: '16' }])
          expect((await client.query(`SELECT count(*)::int AS events
            FROM knowledge.kb_metering_events WHERE owner_id = $1`, [owner])).rows)
            .toEqual([{ events: 2 }])
        })
      } finally {
        await pool.end()
      }
    })
  })
})

it('converges an unknown scope as already deleted without creating facts', async () => {
  await withPublicationFixture(async (fixture) => {
    const owner = fixture.owners[0]
    const { pool } = await openLocalDatabase('api')
    try {
      const apply = createKnowledgeDeletionApplier(pool, principal(owner))
      expect(await apply({
        schemaVersion: 1, id: randomUUID(), ownerId: owner,
        scope: { kind: 'document', spaceId: randomUUID(), documentId: randomUUID() },
        recordedAt: Date.now(),
      })).toBe('DELETED')
      await inRoleTransaction('api', owner, async (client) => {
        expect((await client.query(`SELECT count(*)::int AS documents
          FROM knowledge.kb_documents WHERE owner_id = $1 AND deleted_at IS NOT NULL`, [owner])).rows)
          .toEqual([{ documents: 0 }])
      })
    } finally {
      await pool.end()
    }
  })
})

it('keeps the journal intent when the database is unavailable, then converges later', async () => {
  await withPublicationFixture(async (fixture) => {
    const owner = fixture.owners[0]
    await publicationTransaction(fixture, (transaction) => publishBuild(transaction, fixture.context))
    await withJournal(async (directory) => {
      const journal = await createFileDeletionJournal(directory)
      const recorded = await journal.append({
        schemaVersion: 1, id: randomUUID(), ownerId: owner,
        scope: { kind: 'document', spaceId: fixture.id, documentId: fixture.id },
        recordedAt: Date.now(),
      })
      const { pool } = await openLocalDatabase('api')
      // 先断开连接，验证 PG 不可用时：报 503 但日志意图仍在。
      await pool.end()
      await expect(createKnowledgeDeletionApplier(pool, principal(owner))(recorded))
        .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      // PG 恢复后：同一意图重放即收敛。
      const retried = await openLocalDatabase('api')
      try {
        const apply = createKnowledgeDeletionApplier(retried.pool, principal(owner))
        expect(await apply(recorded)).toBe('DELETED')
      } finally {
        await retried.pool.end()
      }
      await expect(createKnowledgeDeletionApplier({ connect: () => Promise.reject(new Error('down')) }, principal(owner))(recorded))
        .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    })
  })
})