import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'
import {
  bindOperationAttempt,
  rebindOperationAttempt,
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
  // 此处只做轻量预检查；INSERT时的取消门按统一父锁序复核phase与绑定，
  // 不能把这里的无锁快照或FK存在性当作取消后仍可写入的授权。
  const { rows } = await transaction.query(
    `SELECT phase::text AS phase, document_id::text AS document_id,
            target_version_id::text AS version_id,
            expected_generation::text AS expected_generation,
            current_build_id::text AS current_build_id,
            current_job_id::text AS current_job_id,
            current_retry_count AS current_retry_count
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
        current_build_id: string | null
        current_job_id: string | null
        current_retry_count: number | null
      }
    | undefined
  if (!operation) deny('NOT_FOUND')
  // B6.4：队列重试（同job、retryCount+1）的重投递在换绑前先认领新构建行；
  // 其余已绑定形态仍拒绝，换绑只认前一重试，认领路径绝不静默换绑。
  const retryClaim =
    operation.current_build_id !== null &&
    operation.current_job_id === job.id &&
    operation.current_retry_count === job.retryCount - 1
  if (
    operation.version_id === null ||
    (operation.current_build_id !== null && !retryClaim) ||
    !['queued', 'parsing', 'indexing'].includes(operation.phase)
  )
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
  // B6.3/B6.4 绑定CAS：INSERT成功后（取消门触发器已按锁序持行锁）把本次
  // attempt绑定为operation的current attempt；空绑定走bind，队列重试（前一
  // 重试绑定在场）走rebind；绑定走SECURITY DEFINER窄入口（worker对
  // kb_operations无任何UPDATE权限），其他绑定形态已被INSERT取消门拒绝。
  if (retryClaim) {
    await rebindOperationAttempt(transaction, job, envelope)
  } else {
    await bindOperationAttempt(transaction, job, envelope)
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce(nullif($8, '')::tsvector, to_tsvector('simple', $5)))`,
      // searchVector 为空串表示由数据库端按 chunk 文本计算，实际检索索引不落空。
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
  // 父锁与Build锁由窄入口统一获取，不能先锁Build再倒锁Quota。
  const { rows } = await transaction.query(
    'SELECT knowledge.seal_locked_build($1, $2, $3::jsonb, $4::timestamptz) AS status',
    [context.ownerId, context.buildId, JSON.stringify(manifest), now.toISOString()],
  )
  const status = (rows[0] as { status?: unknown } | undefined)?.status
  switch (status) {
    case 'SEALED':
      return
    case 'INVALID_REQUEST':
    case 'UNAUTHENTICATED':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'VERSION_CONFLICT':
      return deny(status)
    default:
      return deny('SERVICE_UNAVAILABLE')
  }
}

// 发布、容量转正与存储事实只能走同一窄入口，锁序由数据库统一维护。
export async function publishBuild(
  transaction: KnowledgeTransaction,
  context: Pick<
    QueueBuildContext,
    'ownerId' | 'documentId' | 'operationId' | 'versionId' | 'buildId' | 'indexProfileId'
  >,
) {
  const { rows } = await transaction.query(
    'SELECT knowledge.publish_reserved_build($1, $2, $3, $4, $5, $6) AS status',
    [
      context.ownerId,
      context.documentId,
      context.operationId,
      context.versionId,
      context.buildId,
      context.indexProfileId,
    ],
  )
  const status = (rows[0] as { status?: unknown } | undefined)?.status
  switch (status) {
    case 'PUBLISHED':
    case 'REPLAY':
      return { replayed: status === 'REPLAY' }
    case 'INVALID_REQUEST':
    case 'UNAUTHENTICATED':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'NOT_CONFIGURED':
    case 'QUOTA_EXCEEDED':
    case 'VERSION_CONFLICT':
      return deny(status)
    default:
      return deny('SERVICE_UNAVAILABLE')
  }
}
