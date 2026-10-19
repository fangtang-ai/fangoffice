import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  claimBuild,
  resolveQueueBuild,
  reserveInitialCapacity,
  sealBuild,
  writeBuildContent,
} from '../src/runtime'
import type { KnowledgeTransaction } from '../src/runtime'
import {
  capacityInput,
  capacityTransaction,
  type CapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

export async function publicationTransaction<Result>(
  fixture: CapacityFixture,
  work: (transaction: KnowledgeTransaction) => Promise<Result>,
) {
  return capacityTransaction(fixture, work, fixture.owners[0], 'worker')
}

export async function admitPublication(fixture: CapacityFixture) {
  const { pool } = await openLocalDatabase('bootstrap')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM knowledge.kb_reservations WHERE owner_id = $1', [
      fixture.owners[0],
    ])
    await client.query(
      `UPDATE knowledge.kb_quotas SET policy_revision = 'synthetic',
      limit_files = 1, limit_bytes = 4, limit_chunks = 1 WHERE owner_id = $1`,
      [fixture.owners[0]],
    )
    // 初始通用夹具含一条与零活动额度不一致的演示事件；只清理本合成owner，
    // trigger停用/恢复及删除共用bootstrap事务，绝不修改已接受事件事实。
    await client.query(
      'ALTER TABLE knowledge.kb_metering_events DISABLE TRIGGER kb_immutable_facts',
    )
    await client.query('DELETE FROM knowledge.kb_metering_events WHERE owner_id = $1', [
      fixture.owners[0],
    ])
    await client.query('ALTER TABLE knowledge.kb_metering_events ENABLE TRIGGER kb_immutable_facts')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
  await capacityTransaction(fixture, (transaction) =>
    reserveInitialCapacity(transaction, capacityInput(fixture)),
  )
}

export async function preparePublication(fixture: CapacityFixture) {
  await admitPublication(fixture)
  const context = await publicationTransaction(fixture, async (transaction) => {
    const build = await resolveQueueBuild(
      transaction,
      { id: fixture.id, retryCount: 0 },
      {
        ownerId: fixture.owners[0],
        operationId: fixture.id,
        buildId: fixture.id,
        receiptId: fixture.id,
      },
    )
    await sealBuild(transaction, build, {})
    return build
  })
  return { ...fixture, context }
}

export async function withPublicationFixture(
  work: (
    fixture: CapacityFixture & Awaited<ReturnType<typeof preparePublication>>,
  ) => Promise<void>,
) {
  await withCapacityFixture(async (fixture) => work(await preparePublication(fixture)))
}

export async function preparePublicationBuild(fixture: CapacityFixture, operationId: string) {
  return publicationTransaction(fixture, async (transaction) => {
    const buildId = randomUUID()
    const context = await claimBuild(
      transaction,
      { id: randomUUID(), retryCount: 0 },
      {
        ownerId: fixture.owners[0],
        operationId,
        buildId,
        receiptId: fixture.id,
      },
      { indexProfileId: fixture.profileId, parserRevision: 'synthetic', parserSnapshot: {} },
    )
    const unitId = randomUUID()
    const chunkId = randomUUID()
    const hash = Buffer.from('ab'.repeat(32), 'hex')
    await writeBuildContent(transaction, context, {
      sourceUnits: [
        {
          id: unitId,
          ordinal: 0,
          type: 'paragraph',
          text: 'Synthetic',
          textHash: hash,
          locator: {},
          coverage: {},
          warnings: [],
        },
      ],
      chunks: [
        {
          id: chunkId,
          ordinal: 0,
          text: 'Synthetic',
          textHash: hash,
          tokenCount: 1,
          searchVector: 'synthetic:1',
        },
      ],
      chunkSources: [
        { chunkId, spanNo: 0, sourceUnitId: unitId, startCp: 0, endCp: 1, mapping: {} },
      ],
      embeddings: [
        {
          chunkId,
          embedding: JSON.stringify([1, ...Array<number>(1023).fill(0)]),
          embeddedTextHash: hash,
        },
      ],
    })
    await sealBuild(transaction, context, {})
    return context
  })
}

export async function publicationState(fixture: CapacityFixture) {
  return inRoleTransaction(
    'api',
    fixture.owners[0],
    async (client) =>
      (
        await client.query(
          `SELECT to_jsonb(quota) AS quota,
      (SELECT to_jsonb(document) FROM knowledge.kb_documents document WHERE owner_id = $1 AND id = $2) AS document,
      (SELECT jsonb_agg(operation ORDER BY id) FROM knowledge.kb_operations operation WHERE owner_id = $1) AS operations,
      (SELECT jsonb_agg(reservation ORDER BY operation_id) FROM knowledge.kb_reservations reservation WHERE owner_id = $1) AS reservations,
      (SELECT jsonb_agg(event ORDER BY sequence) FROM knowledge.kb_metering_events event WHERE owner_id = $1) AS events
     FROM knowledge.kb_quotas quota WHERE owner_id = $1`,
          [fixture.owners[0], fixture.id],
        )
      ).rows,
  )
}

export async function expectPublishedCapacity(fixture: CapacityFixture) {
  await inRoleTransaction('api', fixture.owners[0], async (client) => {
    expect(
      (
        await client.query(
          `SELECT active_files::text AS files, active_bytes::text AS bytes,
      active_chunks::text AS chunks, reserved_files::text AS reserved_files,
      reserved_bytes::text AS reserved_bytes, reserved_chunks::text AS reserved_chunks,
      physical_reserved_bytes::text AS physical_reserved,
      physical_accounted_bytes::text AS physical_accounted FROM knowledge.kb_quotas WHERE owner_id = $1`,
          [fixture.owners[0]],
        )
      ).rows,
    ).toEqual([
      {
        files: '1',
        bytes: '4',
        chunks: '1',
        reserved_files: '0',
        reserved_bytes: '0',
        reserved_chunks: '0',
        physical_reserved: '0',
        physical_accounted: '16',
      },
    ])
    expect(
      (
        await client.query(
          `SELECT active_build_id::text AS build, generation::text AS generation,
      desired_operation_id AS desired FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2`,
          [fixture.owners[0], fixture.id],
        )
      ).rows,
    ).toEqual([{ build: fixture.id, generation: '1', desired: null }])
    expect(
      (
        await client.query(
          `SELECT state, closed_at IS NOT NULL AS closed FROM knowledge.kb_reservations WHERE owner_id = $1 AND operation_id = $2`,
          [fixture.owners[0], fixture.id],
        )
      ).rows,
    ).toEqual([{ state: 'applied', closed: true }])
    expect(
      (
        await client.query(
          `SELECT logical_event_key, subject_key, sequence::text AS sequence,
      active_bytes_before::text AS before, active_bytes_after::text AS after, quantity::text AS quantity,
      event_type, dimension, unit, payer, usage_source, delivery_state
      FROM knowledge.kb_metering_events WHERE owner_id = $1`,
          [fixture.owners[0]],
        )
      ).rows,
    ).toEqual([
      {
        logical_event_key: `capacity:publish:${fixture.id}`,
        subject_key: fixture.id,
        sequence: '1',
        before: '0',
        after: '4',
        quantity: '4',
        event_type: 'capacity_change',
        dimension: 'storage',
        unit: 'bytes',
        payer: 'platform',
        usage_source: 'reconciled',
        delivery_state: 'pending',
      },
    ])
  })
}
