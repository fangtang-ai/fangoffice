import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PgBoss } from 'pg-boss'
import { KnowledgePolicyError } from '../src/errors'
import { createKnowledgePrincipal } from '../src/identity'
import { parseQueueEnvelope, resolveQueueBuild } from '../src/runtime/queue-envelope'
import type { KnowledgeTransaction } from '../src/runtime/transaction'
import { withKnowledgeTransaction } from '../src/runtime/transaction'
import { openLocalDatabase } from './local-database'
import { removeTenants, seedTenants } from './tenant-fixtures'

// B4/B6 队列信封验证：在队列驱动之上，验证载荷只携带引用标识、所有权与
// attempt 绑定由可信事实表重建。构建身份行不可 UPDATE（kb_build_identity），
// 认领即 INSERT——夹具用 bootstrap 直接按真实流程插入认领行。信封 owner
// 决定 RLS 视界，任何分量错误（换 owner、旧 attempt、错误 receipt、已封存
// 构建）都必须拒绝。

const QUEUE = 'b4_validate'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('queue-envelope')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

const principal = (owner: string, now = Date.now()) =>
  createKnowledgePrincipal(
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

const envelopeFor = (owner: string, buildId: string, receiptId = fixture.id) => ({
  ownerId: owner,
  operationId: fixture.id,
  buildId,
  receiptId,
})

// 真实 claim 流程：认领即按 (owner, operation, job_id, retry_count) 插入新的
// 构建身份行；返回新 build uuid 供信封引用。
// 夹具变更必须提交：tenant-fixtures 的 inRoleTransaction 是回滚式事务，只适合探针。
async function bootstrapExec(text: string, values: unknown[]) {
  const { pool } = await openLocalDatabase('bootstrap')
  try {
    await pool.query(text, values)
  } finally {
    await pool.end()
  }
}

async function insertClaim(owner: string, jobId: string, retryCount = 0): Promise<string> {
  const buildId = randomUUID()
  await bootstrapExec(
    `INSERT INTO knowledge.kb_builds
     (owner_id, id, document_id, version_id, operation_id, job_id, retry_count,
      expected_generation, index_profile_id, parser_revision, parser_snapshot)
     VALUES ($1, $6, $2, $2, $2, $3, $4, 0, $5, 'synthetic', '{}')`,
    [owner, fixture.id, jobId, retryCount, fixture.profileId, buildId],
  )
  return buildId
}

async function resolveAsWorker(
  owner: string,
  transaction: KnowledgeTransaction,
  jobId: string,
  data: unknown,
) {
  const envelope = parseQueueEnvelope(data)
  return resolveQueueBuild(transaction, { id: jobId, retryCount: 0 }, envelope)
}

async function openBoss(apiPool: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}) {
  const boss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (text, values) => apiPool.query(text, values) },
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  boss.on('error', () => {})
  return boss
}

it('resolves a valid envelope to the trusted build context inside the worker transaction', async () => {
  const worker = await openLocalDatabase('worker')
  const { pool: api } = await openLocalDatabase('api')
  const boss = await openBoss(api)
  try {
    const jobId = (await boss.send(QUEUE, envelopeFor(fixture.owners[0], fixture.id))) as string
    const buildId = await insertClaim(fixture.owners[0], jobId)
    const { rows: claimed } = await worker.pool.query(
      'SELECT id::text, retry_count FROM pgboss.job_common WHERE id = $1',
      [jobId],
    )
    expect(claimed).toHaveLength(1)
    expect((claimed[0] as { retry_count: number }).retry_count).toBe(0)
    const resolved = await withKnowledgeTransaction(
      worker.pool,
      principal(fixture.owners[0]),
      (transaction) =>
        resolveQueueBuild(
          transaction,
          { id: jobId, retryCount: 0 },
          parseQueueEnvelope(envelopeFor(fixture.owners[0], buildId)),
        ),
    )
    expect(resolved).toEqual({
      ownerId: fixture.owners[0],
      buildId,
      operationId: fixture.id,
      documentId: fixture.id,
      versionId: fixture.id,
      indexProfileId: fixture.profileId,
      expectedGeneration: 0,
      operationKind: 'upload',
      operationPhase: 'queued',
      receiptStatus: 'pending',
    })
  } finally {
    await worker.pool.end()
    await api.end()
  }
})

it('rejects a malformed envelope payload before any database statement', () => {
  const valid = envelopeFor('ok-owner', fixture.id)
  for (const broken of [
    null,
    undefined,
    [],
    'envelope',
    42,
    { ...valid, ownerId: ' padded ' },
    { ...valid, ownerId: 42 },
    { ...valid, operationId: 'not-a-uuid' },
    { ...valid, buildId: null },
    { ...valid, receiptId: 'AR-1' },
    { ...valid, extra: 1 },
    { ownerId: 'ok-owner', operationId: fixture.id, buildId: fixture.id },
  ]) {
    try {
      parseQueueEnvelope(broken)
      expect.unreachable('envelope should have been rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(KnowledgePolicyError)
      expect((error as KnowledgePolicyError).code).toBe('INVALID_REQUEST')
    }
  }
})

it('rejects a swapped owner as not found even when ids collide across owners', async () => {
  // 两个夹具 owner 的构建/操作 uuid 相同；owner A 有真实任务的认领行，
  // owner B 的同 uuid 种子行绑定的是占位 job_id（fixture.id）。用 owner B
  // 信封冒领 owner A 的任务：RLS 视界内 owner B 的行没有该 job 绑定。
  const worker = await openLocalDatabase('worker')
  const { pool: api } = await openLocalDatabase('api')
  const boss = await openBoss(api)
  try {
    const jobId = (await boss.send(QUEUE, { ownerId: fixture.owners[0] })) as string
    await insertClaim(fixture.owners[0], jobId)
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[1]), (transaction) =>
        resolveAsWorker(
          fixture.owners[1],
          transaction,
          jobId,
          envelopeFor(fixture.owners[1], fixture.id),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  } finally {
    await worker.pool.end()
    await api.end()
  }
})

it('rejects a mismatched operation reference as not found', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        resolveQueueBuild(
          transaction,
          { id: fixture.id, retryCount: 0 },
          parseQueueEnvelope({
            ...envelopeFor(fixture.owners[0], fixture.id),
            operationId: randomUUID(),
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  } finally {
    await worker.pool.end()
  }
})

it('rejects a stale attempt binding as not found', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    // 种子行绑定 job_id=fixture.id/retry_count=0；用 attempt 1 结算旧认领必须拒绝。
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        resolveQueueBuild(
          transaction,
          { id: fixture.id, retryCount: 1 },
          parseQueueEnvelope(envelopeFor(fixture.owners[0], fixture.id)),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  } finally {
    await worker.pool.end()
  }
})

it('rejects sealed and purged builds instead of resolving them', async () => {
  // sealed 需要 sealed_at + manifest + manifest_hash（32 字节）同时非空。
  const manifestHash = Buffer.alloc(32, 0xab)
  await bootstrapExec(
    `UPDATE knowledge.kb_builds
        SET status = 'sealed', sealed_at = now(), manifest = '{}'::jsonb,
            manifest_hash = $3
      WHERE owner_id = $1 AND id = $2`,
    [fixture.owners[1], fixture.id, manifestHash],
  )
  const worker = await openLocalDatabase('worker')
  try {
    // 已封存：行可见但状态不匹配 → FORBIDDEN。
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[1]), (transaction) =>
        resolveAsWorker(
          fixture.owners[1],
          transaction,
          fixture.id,
          envelopeFor(fixture.owners[1], fixture.id),
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // GC 已清除：行被 gc_state 过滤 → NOT_FOUND。
    await bootstrapExec(
      `UPDATE knowledge.kb_builds SET status = 'purged', gc_state = 'purged', purged_at = now()
        WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[1], fixture.id],
    )
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[1]), (transaction) =>
        resolveAsWorker(
          fixture.owners[1],
          transaction,
          fixture.id,
          envelopeFor(fixture.owners[1], fixture.id),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  } finally {
    await worker.pool.end()
  }
})

it('rejects a receipt that is no longer pending', async () => {
  // 确认字段（site_receipt_id/confirmed_at/site_amounts）与 status 同在
  // immutable-facts 白名单内，按 confirmation_check 一并置值。用 ownerA 的
  // 种子行（ownerB 的行已被上一个测试 purge）。
  await bootstrapExec(
    `UPDATE knowledge.kb_billing_receipts
        SET status = 'settled', site_receipt_id = '99999999-9999-4999-8999-999999999999',
            confirmed_at = now(), site_amounts = '{}'
      WHERE owner_id = $1 AND id = $2`,
    [fixture.owners[0], fixture.id],
  )
  const worker = await openLocalDatabase('worker')
  try {
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        resolveAsWorker(
          fixture.owners[0],
          transaction,
          fixture.id,
          envelopeFor(fixture.owners[0], fixture.id),
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('rejects an envelope whose receipt is absent', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        resolveAsWorker(
          fixture.owners[0],
          transaction,
          fixture.id,
          envelopeFor(fixture.owners[0], fixture.id, '00000000-0000-4000-8000-000000000000'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  } finally {
    await worker.pool.end()
  }
})
