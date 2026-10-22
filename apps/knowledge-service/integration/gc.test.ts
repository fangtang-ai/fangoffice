import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createKnowledgeGcApplier, publishBuild } from '../src/runtime'
import { openLocalDatabase } from './local-database'
import {
  capacityTransaction,
  type CapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'
import {
  publicationTransaction,
  withPublicationFixture,
} from './publication-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

// GC是写路径：断言helper（inRoleTransaction）一律回滚，这里走独立提交事务。
const collectPurgedBuild = async (owner: string, buildId: string) => {
  const { pool } = await openLocalDatabase('gc')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT knowledge.collect_purged_build($1, $2, $3) AS status',
      [owner, buildId, new Date()],
    )
    await client.query('COMMIT')
    return rows[0].status as string
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

const failAttempt = (fixture: CapacityFixture) =>
  capacityTransaction(
    fixture,
    (transaction) =>
      transaction.query('SELECT knowledge.fail_current_build_attempt($1, $2, $3, $4) AS status', [
        fixture.id,
        fixture.id,
        0,
        'synthetic-failure',
      ]),
    fixture.owners[0],
    'worker',
  )

const gcLedger = async (fixture: CapacityFixture) =>
  inRoleTransaction('api', fixture.owners[0], async (client) => {
    const { rows } = await client.query<{ accounted: string; physical: string }>(
      `SELECT physical_accounted_bytes::text AS accounted,
              physical_reserved_bytes::text AS physical
         FROM knowledge.kb_quotas WHERE owner_id = $1`,
      [fixture.owners[0]],
    )
    return rows[0]
  })

const buildRow = async (fixture: CapacityFixture) =>
  inRoleTransaction('api', fixture.owners[0], async (client) => {
    const { rows } = await client.query<{
      status: string
      gcState: string
      purgedAt: string | null
    }>(
      `SELECT status, gc_state AS "gcState", purged_at::text AS "purgedAt"
         FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    return rows[0]
  })

const tombstoneFacts = async (fixture: CapacityFixture) =>
  inRoleTransaction('api', fixture.owners[0], async (client) => {
    const { rows } = await client.query<{ deleteOps: string; deletedAt: string | null }>(
      `SELECT (SELECT count(*)::text FROM knowledge.kb_operations
                WHERE owner_id = $1 AND document_id = $2 AND kind = 'delete'
                  AND phase = 'deleted') AS "deleteOps",
              (SELECT deleted_at::text FROM knowledge.kb_documents
                WHERE owner_id = $1 AND id = $2) AS "deletedAt"`,
      [fixture.owners[0], fixture.id],
    )
    return rows[0]
  })

it('clears published debt from accounted bytes after the deletion protocol', async () => {
  await withPublicationFixture(async (fixture) => {
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )
    await capacityTransaction(fixture, async (transaction) => {
      const result = await transaction.query(
        "SELECT knowledge.apply_deletion_intent($1, 'document', $2, $3) AS status",
        [randomUUID(), fixture.id, fixture.id],
      )
      expect(result.rows).toEqual([{ status: 'DELETED' }])
    })
    expect(await gcLedger(fixture)).toEqual({ accounted: '16', physical: '0' })

    expect(await collectPurgedBuild(fixture.owners[0], fixture.id)).toBe('PURGED')
    expect(await gcLedger(fixture)).toEqual({ accounted: '0', physical: '0' })
    expect(await buildRow(fixture)).toEqual({
      status: 'purged',
      gcState: 'purged',
      purgedAt: expect.any(String),
    })
    // 幂等重放不重复清算，删除协议事实原样保留。
    expect(await collectPurgedBuild(fixture.owners[0], fixture.id)).toBe('REPLAY')
    expect(await gcLedger(fixture)).toEqual({ accounted: '0', physical: '0' })
    expect(await tombstoneFacts(fixture)).toEqual({
      deleteOps: '1',
      deletedAt: expect.any(String),
    })
  })
})

it('clears failed-attempt debt from physical reserve without touching accounted bytes', async () => {
  await withPublicationFixture(async (fixture) => {
    await failAttempt(fixture)
    expect(await gcLedger(fixture)).toEqual({ accounted: '0', physical: '16' })

    expect(await collectPurgedBuild(fixture.owners[0], fixture.id)).toBe('PURGED')
    expect(await gcLedger(fixture)).toEqual({ accounted: '0', physical: '0' })
    expect((await buildRow(fixture)).gcState).toBe('purged')
  })
})

it('refuses to purge the build that is actively serving a live document', async () => {
  await withPublicationFixture(async (fixture) => {
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )
    expect(await gcLedger(fixture)).toEqual({ accounted: '16', physical: '0' })

    expect(await collectPurgedBuild(fixture.owners[0], fixture.id)).toBe('FORBIDDEN')
    expect(await buildRow(fixture)).toMatchObject({ status: 'sealed', gcState: 'live' })
    expect(await gcLedger(fixture)).toEqual({ accounted: '16', physical: '0' })
  })
})

it('refuses to purge while the operation is still converging', async () => {
  await withPublicationFixture(async (fixture) => {
    expect(await collectPurgedBuild(fixture.owners[0], fixture.id)).toBe('FORBIDDEN')
    expect((await buildRow(fixture)).gcState).toBe('live')
  })
})

it.each(['worker', 'api'] as const)('denies %s execution of the GC entry', async (role) => {
  await inRoleTransaction(role, undefined, async (client) => {
    await expect(
      client.query('SELECT knowledge.collect_purged_build(NULL, NULL, NULL)'),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it('converges unknown owners and builds without any ledger change', async () => {
  await withCapacityFixture(async (fixture) => {
    expect(await collectPurgedBuild(fixture.owners[1], randomUUID())).toBe('NOT_FOUND')
    expect(await collectPurgedBuild(randomUUID(), randomUUID())).toBe('NOT_FOUND')
  })
})

it('maps replay and refusals through the runtime GC applier', async () => {
  await withPublicationFixture(async (fixture) => {
    await publicationTransaction(fixture, (transaction) =>
      publishBuild(transaction, fixture.context),
    )
    await capacityTransaction(fixture, async (transaction) => {
      await transaction.query("SELECT knowledge.apply_deletion_intent($1, 'document', $2, $3)", [
        randomUUID(),
        fixture.id,
        fixture.id,
      ])
    })
    const { pool } = await openLocalDatabase('gc')
    try {
      const applier = createKnowledgeGcApplier(pool)
      await expect(applier.collectPurgedBuild(fixture.owners[0], fixture.id)).resolves.toBe(
        'PURGED',
      )
      await expect(applier.collectPurgedBuild(fixture.owners[0], fixture.id)).resolves.toBe(
        'REPLAY',
      )
      await expect(
        applier.collectPurgedBuild(fixture.owners[0], randomUUID()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    } finally {
      await pool.end()
    }
  })
})