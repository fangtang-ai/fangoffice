import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PgBoss } from 'pg-boss'
import type { Job } from 'pg-boss'
import { createKnowledgePrincipal } from '../src/identity'
import {
  claimBuild,
  publishBuild,
  sealBuild,
  writeBuildContent,
} from '../src/runtime/build-lifecycle'
import type { BuildContent, QueueBuildContext } from '../src/runtime/build-lifecycle'
import { parseQueueEnvelope } from '../src/runtime/queue-envelope'
import { withKnowledgeTransaction } from '../src/runtime/transaction'
import { openLocalDatabase } from './local-database'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

// B6 构建生命周期验证：worker 认领（信封 buildId 即身份行 id，触发器校验
// operation 事实）、受控内容写入（授权面 + append-only 触发器）与有效封存
// （FOR UPDATE + guard_build_seal 在数据库端按实况计算计数与 manifest hash）。
// 所有断言针对真实角色连接；错误映射沿用 withKnowledgeTransaction 的约定。

const QUEUE = 'b4_validate'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('build-lifecycle')
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

const envelopeFor = (owner: string, buildId: string) => ({
  ownerId: owner,
  operationId: fixture.id,
  buildId,
  receiptId: fixture.id,
})

const claimOptions = () => ({
  indexProfileId: fixture.profileId,
  parserRevision: 'synthetic',
  parserSnapshot: {},
})

async function bootstrapExec(text: string, values: unknown[]) {
  const { pool } = await openLocalDatabase('bootstrap')
  try {
    await pool.query(text, values)
  } finally {
    await pool.end()
  }
}

const hex32 = () => Buffer.from('ab'.repeat(32), 'hex')
const vector1024 = JSON.stringify([0.5, ...Array<number>(1023).fill(0)])

function contentFor(unitId: string, chunkIds: string[]): BuildContent {
  return {
    sourceUnits: [
      {
        id: unitId,
        ordinal: 0,
        type: 'paragraph',
        text: 'Synthetic 雪😀',
        textHash: hex32(),
        locator: {},
        coverage: {},
        warnings: [],
      },
    ],
    chunks: chunkIds.map((id, index) => ({
      id,
      ordinal: index,
      text: `Synthetic chunk ${index}`,
      textHash: hex32(),
      tokenCount: 3,
      searchVector: 'synthetic:1',
    })),
    chunkSources: chunkIds.map((chunkId, index) => ({
      chunkId,
      spanNo: 0,
      sourceUnitId: unitId,
      startCp: index,
      endCp: index + 1,
      mapping: {},
    })),
    embeddings: chunkIds.map((chunkId) => ({
      chunkId,
      embedding: vector1024,
      embeddedTextHash: hex32(),
    })),
  }
}

it('claims a build identity from the envelope and resolves the trusted context', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    const buildId = randomUUID()
    const jobId = randomUUID()
    const resolved = await withKnowledgeTransaction(
      worker.pool,
      principal(fixture.owners[0]),
      (transaction) =>
        claimBuild(
          transaction,
          { id: jobId, retryCount: 0 },
          parseQueueEnvelope(envelopeFor(fixture.owners[0], buildId)),
          claimOptions(),
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
    // 行断言必须带 owner 上下文（RLS 视界内）才能看到认领行。
    const { rows } = await inRoleTransaction('worker', fixture.owners[0], (client) =>
      client.query(
        `SELECT job_id::text AS job_id, retry_count, status::text AS status,
                gc_state::text AS gc_state FROM knowledge.kb_builds
          WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], buildId],
      ),
    )
    expect(rows[0]).toMatchObject({
      job_id: jobId,
      retry_count: 0,
      status: 'building',
      gc_state: 'live',
    })
  } finally {
    await worker.pool.end()
  }
})

it('rejects a claim whose operation is missing, cross-owner or not claimable', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    // RLS 视界内的 0 行统一表现为 NOT_FOUND（未知或跨 owner 同语义）；
    // 信封的 operationId 指向不存在的 operation。
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        claimBuild(
          transaction,
          { id: randomUUID(), retryCount: 0 },
          parseQueueEnvelope({
            ownerId: fixture.owners[0],
            operationId: randomUUID(),
            buildId: randomUUID(),
            receiptId: fixture.id,
          }),
          claimOptions(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // 已脱离认领窗口的 operation（published 之后的 ready）不可认领。
    const readyOperationId = randomUUID()
    await bootstrapExec(
      `INSERT INTO knowledge.kb_operations
       (owner_id, id, document_id, idempotency_key, request_hash, kind, phase,
        target_version_id, expected_generation)
       VALUES ($1, $2, $3, 'ready-op', decode(repeat('ab', 32), 'hex'), 'upload',
        'ready', $4, 0)`,
      [fixture.owners[0], readyOperationId, fixture.id, fixture.id],
    )
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        claimBuild(
          transaction,
          { id: randomUUID(), retryCount: 0 },
          parseQueueEnvelope({
            ownerId: fixture.owners[0],
            operationId: readyOperationId,
            buildId: randomUUID(),
            receiptId: fixture.id,
          }),
          claimOptions(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('rejects a duplicate claim of the same envelope build id', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    const buildId = randomUUID()
    const job = { id: randomUUID(), retryCount: 0 }
    const envelope = parseQueueEnvelope(envelopeFor(fixture.owners[0], buildId))
    await withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
      claimBuild(transaction, job, envelope, claimOptions()),
    )
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        claimBuild(transaction, job, envelope, claimOptions()),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('writes controlled build content through the worker role', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    const unitId = randomUUID()
    const chunkIds = [randomUUID(), randomUUID()]
    const buildId = randomUUID()
    const jobId = randomUUID()
    const context = await withKnowledgeTransaction(
      worker.pool,
      principal(fixture.owners[0]),
      async (transaction) => {
        const resolved = await claimBuild(
          transaction,
          { id: jobId, retryCount: 0 },
          parseQueueEnvelope(envelopeFor(fixture.owners[0], buildId)),
          claimOptions(),
        )
        await writeBuildContent(transaction, resolved, contentFor(unitId, chunkIds))
        return resolved
      },
    )
    // 行断言带 owner 上下文（RLS 视界内）。
    const { rows } = await inRoleTransaction('worker', fixture.owners[0], (client) =>
      client.query(
        `SELECT
           (SELECT count(*) FROM knowledge.kb_source_units
             WHERE owner_id = $1 AND build_id = $2) AS units,
           (SELECT count(*) FROM knowledge.kb_chunks
             WHERE owner_id = $1 AND build_id = $2) AS chunks,
           (SELECT count(*) FROM knowledge.kb_chunk_sources
             WHERE owner_id = $1 AND build_id = $2) AS sources,
           (SELECT count(*) FROM knowledge.kb_chunk_embeddings
             WHERE owner_id = $1 AND build_id = $2) AS embeddings,
           status::text AS status
         FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], buildId],
      ),
    )
    expect(rows[0]).toEqual({
      units: '1',
      chunks: '2',
      sources: '2',
      embeddings: '2',
      status: 'building',
    })
    expect(context.buildId).toBe(buildId)
  } finally {
    await worker.pool.end()
  }
})

it('seals a build with database-computed counts and manifest hash', async () => {
  const worker = await openLocalDatabase('worker')
  let context: QueueBuildContext | undefined
  try {
    const manifest = { chunks: 2, coverage: 'full' }
    const unitId = randomUUID()
    const chunkIds = [randomUUID(), randomUUID()]
    context = await withKnowledgeTransaction(
      worker.pool,
      principal(fixture.owners[0]),
      async (transaction) => {
        const resolved = await claimBuild(
          transaction,
          { id: randomUUID(), retryCount: 0 },
          parseQueueEnvelope(envelopeFor(fixture.owners[0], randomUUID())),
          claimOptions(),
        )
        await writeBuildContent(transaction, resolved, contentFor(unitId, chunkIds))
        await sealBuild(transaction, resolved, manifest)
        return resolved
      },
    )
    // 行断言带 owner 上下文（RLS 视界内）。
    const { rows } = await inRoleTransaction('worker', fixture.owners[0], (client) =>
      client.query(
        `SELECT status::text AS status, sealed_at IS NOT NULL AS sealed,
                manifest, manifest_hash = sha256(convert_to(manifest::text, 'UTF8')) AS hash_ok,
                source_unit_count AS units, chunk_count AS chunks,
                embedding_count AS embeddings
           FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], context!.buildId],
      ),
    )
    expect(rows[0]).toMatchObject({
      status: 'sealed',
      sealed: true,
      manifest,
      hash_ok: true,
      units: '1',
      chunks: '2',
      embeddings: '2',
    })
  } finally {
    await worker.pool.end()
  }
  // 后续场景复用这个已封存构建。
  sealedContext = context
})

let sealedContext: QueueBuildContext | undefined

it('forbids sealing outside the building window or twice', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    expect(sealedContext).toBeDefined()
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        sealBuild(transaction, sealedContext!, { again: true }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('rejects content writes and snapshot rewrites after sealing', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    expect(sealedContext).toBeDefined()
    // append-only 触发器拒绝后续写入；非策略错误按约定映射为 SERVICE_UNAVAILABLE。
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        writeBuildContent(transaction, sealedContext!, contentFor(randomUUID(), [randomUUID()])),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    // 已封存的快照列改写同样被数据库拒绝。
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        transaction.query(
          `UPDATE knowledge.kb_builds SET manifest = $3::jsonb
            WHERE owner_id = $1 AND id = $2`,
          [fixture.owners[0], sealedContext!.buildId, {}],
        ),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  } finally {
    await worker.pool.end()
  }
})

it('denies the api role any claim, content write or seal', async () => {
  const buildId = randomUUID()
  // api 没有 kb_builds 的 INSERT/UPDATE，也没有内容表 INSERT。
  await expect(
    inRoleTransaction('api', fixture.owners[0], async (client) => {
      await client.query(
        `INSERT INTO knowledge.kb_builds
         (owner_id, id, document_id, version_id, operation_id, job_id, retry_count,
          expected_generation, index_profile_id, parser_revision, parser_snapshot)
         VALUES ($1, $2, $3, $3, $3, $2, 0, 0, $4, 'synthetic', '{}')`,
        [fixture.owners[0], buildId, fixture.id, fixture.profileId],
      )
    }),
  ).rejects.toMatchObject({ code: '42501' })
  await expect(
    inRoleTransaction('api', fixture.owners[0], async (client) => {
      await client.query(
        `UPDATE knowledge.kb_builds SET status = 'sealed', sealed_at = now(),
         manifest = '{}'::jsonb WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], buildId],
      )
    }),
  ).rejects.toMatchObject({ code: '42501' })
  await expect(
    inRoleTransaction('api', fixture.owners[0], async (client) => {
      await client.query(
        `INSERT INTO knowledge.kb_chunks
         (owner_id, build_id, id, ordinal, text, text_hash, token_count, search_vector)
         VALUES ($1, $2, $3, 0, 'x', decode(repeat('ab', 32), 'hex'), 1, 'x')`,
        [fixture.owners[0], buildId, randomUUID()],
      )
    }),
  ).rejects.toMatchObject({ code: '42501' })
})

// ---- B7 发布 ----

async function claimAndSeal(owner: string, { seal = true }: { seal?: boolean } = {}) {
  const worker = await openLocalDatabase('worker')
  try {
    const buildId = randomUUID()
    return await withKnowledgeTransaction(worker.pool, principal(owner), async (transaction) => {
      const context = await claimBuild(
        transaction,
        { id: randomUUID(), retryCount: 0 },
        parseQueueEnvelope(envelopeFor(owner, buildId)),
        claimOptions(),
      )
      await writeBuildContent(transaction, context, contentFor(randomUUID(), [randomUUID()]))
      if (seal) await sealBuild(transaction, context, { chunks: 1 })
      return context
    })
  } finally {
    await worker.pool.end()
  }
}

// 代数随发布推进，认领的 expected_generation 来自 operation；每次发布实验
// 前把 operation 重新对齐到当前代数（admission 重新推导语义的最小模拟）。
async function resetOperation(owner: string) {
  await bootstrapExec(
    `UPDATE knowledge.kb_operations o
        SET phase = 'queued',
            expected_generation = (SELECT d.generation FROM knowledge.kb_documents d
                                    WHERE d.owner_id = o.owner_id AND d.id = o.document_id)
      WHERE o.owner_id = $1 AND o.id = $2`,
    [owner, fixture.id],
  )
}

// admission 模拟：desired 指针由 admission/bootstrap 侧维护（gate 2 未实施），
// worker 只读取；这是发布前置非写入方授权面的最小夹具路径。
async function admit(owner: string, context: { operationId: string; versionId: string }) {
  await bootstrapExec(
    `UPDATE knowledge.kb_documents SET desired_operation_id = $3, desired_version_id = $4
      WHERE owner_id = $1 AND id = $2`,
    [owner, fixture.id, context.operationId, context.versionId],
  )
}

it('publishes the sealed build as the active version', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    const context = await claimAndSeal(fixture.owners[0])
    await admit(fixture.owners[0], context)
    await withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
      publishBuild(transaction, context),
    )
    const { rows } = await inRoleTransaction('worker', fixture.owners[0], (client) =>
      client.query(
        `SELECT active_version_id::text AS version, active_build_id::text AS build,
                generation::text AS generation,
                (SELECT phase::text FROM knowledge.kb_operations
                  WHERE owner_id = $1 AND id = $2) AS phase
           FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    )
    expect(rows[0]).toEqual({
      version: fixture.id,
      build: context.buildId,
      generation: '1',
      phase: 'ready',
    })
  } finally {
    await worker.pool.end()
  }
})

it('forbids publishing the same build twice', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    await resetOperation(fixture.owners[0])
    const context = await claimAndSeal(fixture.owners[0])
    await admit(fixture.owners[0], context)
    const publish = () =>
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        publishBuild(transaction, context),
      )
    await publish()
    await expect(publish()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('refuses publishing a build claimed at a stale generation', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    await resetOperation(fixture.owners[0])
    // 同代数并发认领的两个尝试：先发布者胜出，后发布者代数已陈旧。
    const winner = await claimAndSeal(fixture.owners[0])
    const stale = await claimAndSeal(fixture.owners[0])
    await admit(fixture.owners[0], winner)
    await withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
      publishBuild(transaction, winner),
    )
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        publishBuild(transaction, stale),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('refuses publishing without a pending desired operation', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    await resetOperation(fixture.owners[0])
    const context = await claimAndSeal(fixture.owners[0])
    await admit(fixture.owners[0], context)
    await bootstrapExec(
      `UPDATE knowledge.kb_documents SET desired_operation_id = NULL, desired_version_id = NULL
        WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        publishBuild(transaction, context),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('refuses publishing an unsealed build', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    await resetOperation(fixture.owners[0])
    const context = await claimAndSeal(fixture.owners[0], { seal: false })
    await admit(fixture.owners[0], context)
    await expect(
      withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
        publishBuild(transaction, context),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  } finally {
    await worker.pool.end()
  }
})

it('refuses publishing while the owner is frozen', async () => {
  const worker = await openLocalDatabase('worker')
  try {
    await resetOperation(fixture.owners[0])
    const context = await claimAndSeal(fixture.owners[0])
    await admit(fixture.owners[0], context)
    try {
      await bootstrapExec(
        `UPDATE knowledge.kb_quotas SET owner_state = 'frozen' WHERE owner_id = $1`,
        [fixture.owners[0]],
      )
      await expect(
        withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
          publishBuild(transaction, context),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally {
      await bootstrapExec(
        `UPDATE knowledge.kb_quotas SET owner_state = 'active' WHERE owner_id = $1`,
        [fixture.owners[0]],
      )
    }
  } finally {
    await worker.pool.end()
  }
})

it('refuses publishing when the profile is no longer the active one', async () => {
  const worker = await openLocalDatabase('worker')
  const secondProfileId = randomUUID()
  try {
    await resetOperation(fixture.owners[0])
    const context = await claimAndSeal(fixture.owners[0])
    await admit(fixture.owners[0], context)
    try {
      await bootstrapExec(
        `INSERT INTO knowledge.kb_index_profiles
        (id, config_hash, provider, region, model, model_revision, dimension, distance,
         normalization, pipeline_revisions, config)
        VALUES ($1, $2, 'synthetic', 'local', 'not-a-model', 'test', 1024, 'cosine', 'none', '{}', '{}')`,
        [secondProfileId, Buffer.from(secondProfileId.replaceAll('-', '').repeat(2), 'hex')],
      )
      await bootstrapExec(
        `UPDATE knowledge.kb_quotas SET active_index_profile_id = $2 WHERE owner_id = $1`,
        [fixture.owners[0], secondProfileId],
      )
      await expect(
        withKnowledgeTransaction(worker.pool, principal(fixture.owners[0]), (transaction) =>
          publishBuild(transaction, context),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally {
      await bootstrapExec(
        `UPDATE knowledge.kb_quotas SET active_index_profile_id = $2 WHERE owner_id = $1`,
        [fixture.owners[0], fixture.profileId],
      )
      // profile 是不可变事实（B3 门），无法删除；留在库中随 removeTenants 清理边界。
    }
  } finally {
    await worker.pool.end()
  }
})

it('drives the full claim-write-seal-publish lifecycle through a real queue delivery', async () => {
  const worker = await openLocalDatabase('worker')
  const { pool: api } = await openLocalDatabase('api')
  const boss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (text, values) => api.query(text, values) },
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  boss.on('error', () => {})
  const workerBoss = new PgBoss({
    schema: 'pgboss',
    db: { executeSql: (text, values) => worker.pool.query(text, values) },
    createSchema: false,
    migrate: false,
    supervise: false,
    schedule: false,
  })
  workerBoss.on('error', () => {})
  try {
    // 清掉历史失败会话留在 b4_validate 队列里的残渣任务（它们的 owner
    // 已被 removeTenants 删除，永远不可能被认领，只会污染本轮投递）。
    await bootstrapExec('DELETE FROM pgboss.job_common WHERE name = $1', [QUEUE])
    await bootstrapExec('DELETE FROM pgboss.job WHERE name = $1', [QUEUE])
    await resetOperation(fixture.owners[0])
    // 发布面：desired 指针在投递前由 admission 侧就位（本测试 envelope 的
    // operation/version 固定为 fixture.id）。
    await bootstrapExec(
      `UPDATE knowledge.kb_documents SET desired_operation_id = $2, desired_version_id = $2
        WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    const { rows: beforeRows } = await inRoleTransaction('worker', fixture.owners[0], (client) =>
      client.query(
        'SELECT generation::text AS generation FROM knowledge.kb_documents WHERE owner_id = $1 AND id = $2',
        [fixture.owners[0], fixture.id],
      ),
    )
    const buildId = randomUUID()
    const envelope = envelopeFor(fixture.owners[0], buildId)
    const completed = new Promise<void>((resolve, reject) => {
      workerBoss.work(
        QUEUE,
        { pollingIntervalSeconds: 1 },
        async (jobs: Job<typeof envelope>[]) => {
          // 只处理本次投递的任务；队列里的其他残留任务按已完成吞捽。
          const job = jobs.find((entry) => entry.data?.buildId === buildId)
          if (!job) return { accepted: true }
          try {
            const parsed = parseQueueEnvelope(job.data)
            const unitId = randomUUID()
            const chunkIds = [randomUUID()]
            await withKnowledgeTransaction(worker.pool, principal(parsed.ownerId), async (tx) => {
              const context = await claimBuild(
                tx,
                { id: job.id, retryCount: job.retryCount },
                parsed,
                claimOptions(),
              )
              await writeBuildContent(tx, context, contentFor(unitId, chunkIds))
              await sealBuild(tx, context, { chunks: chunkIds.length })
              await publishBuild(tx, context)
            })
            resolve()
          } catch (error) {
            console.error(
              'B6-QUEUE-DEBUG',
              (error as { code?: string; message?: string }).code,
              (error as Error).message,
              'fixture.op=',
              fixture.id,
              'job=',
              (job as { id?: string }).id,
            )
            reject(error)
          }
          return { accepted: true }
        },
      )
    })
    const jobId = (await boss.send(QUEUE, envelope)) as string
    await Promise.race([
      completed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('work() never completed the lifecycle')), 15000),
      ),
    ])
    await workerBoss.offWork(QUEUE)
    // 行断言带 owner 上下文（RLS 视界内）。
    const { rows } = await inRoleTransaction('worker', fixture.owners[0], (client) =>
      client.query(
        `SELECT active_build_id::text AS active_build, generation::text AS generation,
                (SELECT b.status::text FROM knowledge.kb_builds b
                  WHERE b.owner_id = d.owner_id AND b.id = $2) AS status,
                (SELECT b.chunk_count FROM knowledge.kb_builds b
                  WHERE b.owner_id = d.owner_id AND b.id = $2) AS chunks,
                (SELECT state::text FROM pgboss.job_common WHERE id = $3) AS job_state,
                (SELECT phase::text FROM knowledge.kb_operations
                  WHERE owner_id = $1 AND id = d.id) AS op_phase
           FROM knowledge.kb_documents d WHERE d.owner_id = $1 AND d.id = $4`,
        [fixture.owners[0], buildId, jobId, fixture.id],
      ),
    )
    expect(rows[0]).toMatchObject({
      status: 'sealed',
      chunks: '1',
      job_state: 'completed',
      active_build: buildId,
      generation: String(Number(beforeRows[0].generation) + 1),
      op_phase: 'ready',
    })
  } finally {
    await worker.pool.end()
    await api.end()
  }
})
