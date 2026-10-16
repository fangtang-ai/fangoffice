import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'
import {
  resolveQueueBuild,
  type QueueBuildContext,
  type QueueEnvelope,
  type QueueJobRef,
} from './queue-envelope'

export type { QueueBuildContext, QueueEnvelope, QueueJobRef } from './queue-envelope'

// B6 构建生命周期：认领、受控内容写入与有效封存都在 worker 的
// withKnowledgeTransaction 内完成。认领以信封 buildId 插入身份行（构建
// 身份不可 UPDATE，见建造期身份门禁），封存是一次受控 UPDATE——manifest_hash 与三项
// 计数由 guard_build_seal 触发器在数据库端按实况计算，写入方声明不参与。

export interface BuildClaimOptions {
  indexProfileId: string
  parserRevision: string
  parserSnapshot: unknown
}

export interface BuildSourceUnitRow {
  id: string
  parentId?: string
  ordinal: number
  type: string
  text: string
  textHash: Buffer
  locator: unknown
  coverage: unknown
  warnings: unknown
}

export interface BuildChunkRow {
  id: string
  ordinal: number
  text: string
  textHash: Buffer
  tokenCount: number
  searchVector: string
}

export interface BuildChunkSourceRow {
  chunkId: string
  spanNo: number
  sourceUnitId: string
  startCp: number
  endCp: number
  mapping: unknown
}

export interface BuildEmbeddingRow {
  chunkId: string
  embedding: string
  embeddedTextHash: Buffer
}

export interface BuildContent {
  sourceUnits?: BuildSourceUnitRow[]
  chunks?: BuildChunkRow[]
  chunkSources?: BuildChunkSourceRow[]
  embeddings?: BuildEmbeddingRow[]
}

export async function claimBuild(
  transaction: KnowledgeTransaction,
  job: QueueJobRef,
  envelope: QueueEnvelope,
  options: BuildClaimOptions,
): Promise<QueueBuildContext> {
  // 不加锁子句：FOR SHARE 要求 UPDATE 特权（PG 文档 ddl-priv.html），
  // 运行时角色没有 operation 的写面；认领校验 INSERT 时点事实，
  // 行间竞争由 sealBuild 的 FOR UPDATE 与后续发布门处理。
  const { rows } = await transaction.query(
    `SELECT phase::text AS phase, document_id::text AS document_id,
            target_version_id::text AS version_id,
            expected_generation::text AS expected_generation
       FROM knowledge.kb_operations
      WHERE owner_id = $1 AND id = $2`,
    [envelope.ownerId, envelope.operationId],
  )
  const operation = rows[0] as
    | {
        phase: string
        document_id: string
        version_id: string | null
        expected_generation: string
      }
    | undefined
  if (!operation) deny('NOT_FOUND')
  if (operation.version_id === null || !['queued', 'parsing', 'indexing'].includes(operation.phase))
    deny('FORBIDDEN')
  const profile = await transaction.query(
    'SELECT 1 AS ok FROM knowledge.kb_index_profiles WHERE id = $1',
    [options.indexProfileId],
  )
  if (profile.rows.length !== 1) deny('FORBIDDEN')
  // 重复认领（重复投递/replay）在运行时预检查为业务态拒绝；并发竞态下仍
  // 可能触发唯一约束，但 transaction 层会把 pg 错误转换为 SERVICE_UNAVAILABLE。
  const existing = await transaction.query(
    'SELECT 1 AS ok FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2',
    [envelope.ownerId, envelope.buildId],
  )
  if (existing.rows.length !== 0) deny('FORBIDDEN')
  try {
    await transaction.query(
      `INSERT INTO knowledge.kb_builds
         (owner_id, id, document_id, version_id, operation_id, job_id, retry_count,
          expected_generation, index_profile_id, parser_revision, parser_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        envelope.ownerId,
        envelope.buildId,
        operation.document_id,
        operation.version_id,
        envelope.operationId,
        job.id,
        job.retryCount,
        operation.expected_generation,
        options.indexProfileId,
        options.parserRevision,
        JSON.stringify(options.parserSnapshot ?? {}),
      ],
    )
  } catch (error) {
    // 同一 buildId 的重复认领（重复投递/replay）是业务态拒绝。
    if ((error as { code?: string }).code === '23505') deny('FORBIDDEN')
    throw error
  }
  // 认领行必须能被队列信封协议复核通过，才算完成认领。
  return resolveQueueBuild(transaction, job, envelope)
}

export async function writeBuildContent(
  transaction: KnowledgeTransaction,
  context: { ownerId: string; buildId: string },
  content: BuildContent,
): Promise<void> {
  // 行对象只带内容列；owner/build 一律来自解析后的可信上下文。
  for (const unit of content.sourceUnits ?? [])
    await transaction.query(
      `INSERT INTO knowledge.kb_source_units
         (owner_id, build_id, id, parent_id, ordinal, type, text, text_hash,
          locator, coverage, warnings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)`,
      [
        context.ownerId,
        context.buildId,
        unit.id,
        unit.parentId ?? null,
        unit.ordinal,
        unit.type,
        unit.text,
        unit.textHash,
        JSON.stringify(unit.locator),
        JSON.stringify(unit.coverage),
        JSON.stringify(unit.warnings),
      ],
    )
  for (const chunk of content.chunks ?? [])
    await transaction.query(
      `INSERT INTO knowledge.kb_chunks
         (owner_id, build_id, id, ordinal, text, text_hash, token_count, search_vector)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::tsvector)`,
      [
        context.ownerId,
        context.buildId,
        chunk.id,
        chunk.ordinal,
        chunk.text,
        chunk.textHash,
        chunk.tokenCount,
        chunk.searchVector,
      ],
    )
  for (const source of content.chunkSources ?? [])
    await transaction.query(
      `INSERT INTO knowledge.kb_chunk_sources
         (owner_id, build_id, chunk_id, span_no, source_unit_id, start_cp, end_cp, mapping)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        context.ownerId,
        context.buildId,
        source.chunkId,
        source.spanNo,
        source.sourceUnitId,
        source.startCp,
        source.endCp,
        JSON.stringify(source.mapping),
      ],
    )
  for (const embedding of content.embeddings ?? [])
    await transaction.query(
      `INSERT INTO knowledge.kb_chunk_embeddings
         (owner_id, build_id, chunk_id, embedding, embedded_text_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        context.ownerId,
        context.buildId,
        embedding.chunkId,
        embedding.embedding,
        embedding.embeddedTextHash,
      ],
    )
}

export async function sealBuild(
  transaction: KnowledgeTransaction,
  context: { ownerId: string; buildId: string },
  manifest: unknown,
  { now = new Date() }: { now?: Date } = {},
): Promise<void> {
  // 封存前以 FOR UPDATE 锁定（不是 FOR KEY SHARE），挡住并发封存与
  // 建立中的内容写入（guard_build_content 持 FOR SHARE）。
  const { rows } = await transaction.query(
    `SELECT status::text AS status, gc_state::text AS gc_state
       FROM knowledge.kb_builds
      WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
    [context.ownerId, context.buildId],
  )
  const row = rows[0] as { status: string; gc_state: string } | undefined
  if (!row) deny('NOT_FOUND')
  if (row.status !== 'building' || row.gc_state !== 'live') deny('FORBIDDEN')
  await transaction.query(
    `UPDATE knowledge.kb_builds SET status = 'sealed', sealed_at = $3, manifest = $4::jsonb
      WHERE owner_id = $1 AND id = $2`,
    [context.ownerId, context.buildId, now.toISOString(), JSON.stringify(manifest)],
  )
}

// B6 发布切片：把封存构建发布为活跃版本。desired 指针由 admission 维护
// （写入方无该列授权），发布者只读取；指针翻转是一次受控 UPDATE，
// guard_document_publish 在数据库端复核全部前置事实（含 profile 与代数）。
export async function publishBuild(
  transaction: KnowledgeTransaction,
  context: QueueBuildContext,
): Promise<void> {
  // 锁序：document → build → operation；全部事实检查在窗口推进前完成，
  // 陈旧代数的拒绝不会被窗口拒绝掩盘。
  const { rows } = await transaction.query(
    `SELECT deleted_at, space_id::text AS space_id,
            desired_operation_id::text AS desired_operation_id,
            desired_version_id::text AS desired_version_id,
            active_build_id::text AS active_build_id, generation::text AS generation
       FROM knowledge.kb_documents
      WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
    [context.ownerId, context.documentId],
  )
  const doc = rows[0] as
    | {
        deleted_at: string | null
        space_id: string
        desired_operation_id: string | null
        desired_version_id: string | null
        active_build_id: string | null
        generation: string
      }
    | undefined
  if (!doc) deny('NOT_FOUND')
  if (
    doc.deleted_at !== null ||
    doc.desired_operation_id === null ||
    doc.desired_version_id === null ||
    doc.desired_operation_id !== context.operationId ||
    doc.desired_version_id !== context.versionId ||
    doc.active_build_id === context.buildId
  )
    deny('FORBIDDEN')
  const build = await transaction.query(
    `SELECT document_id::text AS document_id, version_id::text AS version_id,
            operation_id::text AS operation_id, expected_generation::text AS expected_generation,
            index_profile_id::text AS index_profile_id, status::text AS status,
            sealed_at, gc_state::text AS gc_state, purged_at
       FROM knowledge.kb_builds
      WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
    [context.ownerId, context.buildId],
  )
  const row = build.rows[0] as
    | {
        document_id: string
        version_id: string
        operation_id: string
        expected_generation: string
        index_profile_id: string
        status: string
        sealed_at: string | null
        gc_state: string
        purged_at: string | null
      }
    | undefined
  if (
    !row ||
    row.document_id !== context.documentId ||
    row.version_id !== context.versionId ||
    row.operation_id !== context.operationId ||
    row.expected_generation !== doc.generation ||
    row.status !== 'sealed' ||
    row.sealed_at === null ||
    row.gc_state !== 'live' ||
    row.purged_at !== null ||
    row.index_profile_id !== context.indexProfileId
  )
    deny('FORBIDDEN')
  // owner/space/profile currency：与门同一套事实（拒绝态简洁，门仍会复核）。
  const states = await transaction.query(
    `SELECT (SELECT owner_state::text FROM knowledge.kb_quotas WHERE owner_id = $1) AS owner_state,
            (SELECT active_index_profile_id::text FROM knowledge.kb_quotas WHERE owner_id = $1) AS profile_id,
            (SELECT state::text FROM knowledge.kb_spaces WHERE owner_id = $1 AND id = $2) AS space_state,
            (SELECT deleted_at FROM knowledge.kb_spaces WHERE owner_id = $1 AND id = $2) AS space_deleted_at`,
    [context.ownerId, doc.space_id],
  )
  const state = states.rows[0] as
    | {
        owner_state: string | null
        profile_id: string | null
        space_state: string | null
        space_deleted_at: string | null
      }
    | undefined
  if (
    !state ||
    state.owner_state !== 'active' ||
    state.profile_id !== context.indexProfileId ||
    state.space_state !== 'active' ||
    state.space_deleted_at !== null
  )
    deny('FORBIDDEN')
  // 发布窗口：operation 必须仍可从建立阶段推进到 publishing；推进本身即窗口检查。
  const window = await transaction.query(
    `UPDATE knowledge.kb_operations SET phase = 'publishing'
      WHERE owner_id = $1 AND id = $2 AND phase IN ('queued', 'parsing', 'indexing')`,
    [context.ownerId, context.operationId],
  )
  if (window.rowCount !== 1) deny('FORBIDDEN')
  // 指针翻转：门失败即 23514，transaction 层按约定映射为 SERVICE_UNAVAILABLE。
  await transaction.query(
    `UPDATE knowledge.kb_documents
        SET active_version_id = $3, active_build_id = $4, generation = generation + 1
      WHERE owner_id = $1 AND id = $2`,
    [context.ownerId, context.documentId, context.versionId, context.buildId],
  )
  await transaction.query(
    `UPDATE knowledge.kb_operations SET phase = 'ready'
      WHERE owner_id = $1 AND id = $2 AND phase = 'publishing'`,
    [context.ownerId, context.operationId],
  )
}
