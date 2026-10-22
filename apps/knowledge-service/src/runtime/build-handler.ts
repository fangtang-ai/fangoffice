import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { deny } from '../errors'
import type { KnowledgePrincipal } from '../identity'
import { createKnowledgeReplayPrincipal } from './deletion'
import {
  claimBuild,
  sealBuild,
  writeBuildContent,
  type BuildContent,
  type BuildEmbeddingRow,
  type BuildSourceUnitRow,
  type QueueEnvelope,
  type QueueJobRef,
} from './build-lifecycle'
import { publishQueuedBuild } from './queued-publication'
import { recordEmbeddingIntent, recordEmbeddingResult, type EmbeddingResultRequest } from './embedding'
import {
  createDashscopeEmbeddingClient,
  KnowledgeEmbeddingProviderError,
} from './embedding-provider'
import { markdownParserRevision, textParserRevision } from '../parsing/text-unit'
import { parseKnowledgeMarkdownInWorker, parseKnowledgeTextInWorker } from '../parsing/worker'
import { createKnowledgeBuildChunkizer, knowledgeUnitUuid } from './build-chunks'
import {
  createKnowledgeImdsCredentialSource,
  type KnowledgeImdsCredentialSource,
} from './imds-credentials'
import { createKnowledgeImdsOssSourceStore, createKnowledgeOssSourceStore } from './oss-source'
import type { KnowledgeTransaction } from './transaction'
import type { KnowledgeWorkerConfig } from './config'

// 分块预算试点取单一硬常量（码点）；检索质量复盘后再接可配置策略。
// shortcut: 固定2000码点预算，试点复盘后升级为可配置分块策略。
export const KNOWLEDGE_BUILD_CHUNK_MAX_CODE_POINTS = 2000

const PARSE_POLICY = {
  maxBytes: 8 * 1024 * 1024,
  maxCodePoints: 4 * 1024 * 1024,
  maxLines: 20000,
} as const

const PARSE_TIMEOUT_MS = 30_000

export interface KnowledgeBuildHandlerDeps {
  fetch?: typeof globalThis.fetch
  now?: () => number
  credentialSource?: KnowledgeImdsCredentialSource
  parseText?: (value: unknown, policy: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  parseMarkdown?: (value: unknown, policy: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
}

interface KnowledgeBuildHandlerDatabase {
  transaction<Result>(
    principal: KnowledgePrincipal,
    work: (transaction: KnowledgeTransaction) => Promise<Result>,
  ): Promise<Result>
}

interface VersionFacts {
  format: 'txt' | 'md'
  bucket: string
  ossKey: string
  fileHash: string
  sizeBytes: bigint
}

interface SourceObject {
  body: NodeJS.ReadableStream
}

interface BuildStore {
  read(input: { bucket?: string; key: string; signal: AbortSignal }): Promise<SourceObject>
}

async function readVerifiedSource(
  store: BuildStore,
  input: { bucket?: string; key: string },
  expected: { sizeBytes: bigint; fileHash: string },
  signal: AbortSignal,
): Promise<Buffer> {
  const object = await store.read({ ...input, signal })
  const hash = createHash('sha256')
  let size = 0n
  const parts: Buffer[] = []
  try {
    for await (const chunk of object.body as unknown as AsyncIterable<Buffer | string>) {
      const bytes = Buffer.from(chunk)
      size += BigInt(bytes.length)
      if (size > PARSE_POLICY.maxBytes) deny('INVALID_REQUEST')
      hash.update(bytes)
      parts.push(bytes)
    }
  } finally {
    ;(object.body as { destroy?: () => void }).destroy?.()
  }
  // 流实况与版本行双向核对：任何一方不一致都说明源对象已不再可信。
  if (size === 0n || size !== expected.sizeBytes || hash.digest('hex') !== expected.fileHash) {
    deny('INVALID_REQUEST')
  }
  return Buffer.concat(parts)
}

function mapProviderError(error: unknown): never {
  if (error instanceof KnowledgeEmbeddingProviderError) {
    deny(error.code === 'provider_rejected' ? 'NOT_CONFIGURED' : 'SERVICE_UNAVAILABLE')
  }
  throw error
}

export function createKnowledgeBuildHandler(
  database: KnowledgeBuildHandlerDatabase,
  config: KnowledgeWorkerConfig,
  deps: KnowledgeBuildHandlerDeps = {},
) {
  if (!config.queueName) deny('NOT_CONFIGURED')
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now
  let imdsSource: KnowledgeImdsCredentialSource | undefined
  let imdsStore: BuildStore | undefined

  function resolveStore(_bucket: string): BuildStore {
    if (config.ossSource) {
      const staticStore = createKnowledgeOssSourceStore(config.ossSource, { now, fetch: fetchImpl })
      return { read: (input) => staticStore.read({ key: input.key, signal: input.signal }) }
    }
    imdsSource ??= deps.credentialSource ?? createKnowledgeImdsCredentialSource({ fetch: fetchImpl, now })
    if (!config.ossRegion) deny('NOT_CONFIGURED')
    imdsStore ??= createKnowledgeImdsOssSourceStore(
      { region: config.ossRegion },
      imdsSource,
      { now, fetch: fetchImpl },
    )
    return { read: (input) => imdsStore!.read(input) }
  }

  return async function handleKnowledgeBuild({
    job,
    envelope,
    signal,
  }: {
    job: QueueJobRef
    envelope: QueueEnvelope
    signal: AbortSignal
  }): Promise<void> {
    if (!config.auth) deny('NOT_CONFIGURED')
    if (signal.aborted) deny('CANCELLED')
    const authority = {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      requiredPermissions: config.auth.requiredPermissions,
    }
    // 与删除重放同款短时效principal：仅绑定信封owner，60秒内完成各自事务。
    const principal = (ownerId: string) => createKnowledgeReplayPrincipal(ownerId, authority, now())
    const parseText =
      deps.parseText ??
      ((value: unknown, policy: unknown) =>
        parseKnowledgeTextInWorker(value, policy, { signal, timeoutMs: PARSE_TIMEOUT_MS }))
    const parseMarkdown =
      deps.parseMarkdown ??
      ((value: unknown, policy: unknown) =>
        parseKnowledgeMarkdownInWorker(value, policy, { signal, timeoutMs: PARSE_TIMEOUT_MS }))

    // T1 认领事务：版本事实（经 operation 行 JOIN）→ 认领构建行 → 嵌入意图记账。
    const claimed = await database.transaction(principal(envelope.ownerId), async (transaction) => {
      const { rows } = await transaction.query(
        `SELECT version.format::text AS format, version.bucket AS bucket,
                version.oss_key AS oss_key, encode(version.file_hash, 'hex') AS file_hash,
                version.size_bytes::text AS size_bytes
           FROM knowledge.kb_operations operation
           JOIN knowledge.kb_versions version
             ON version.owner_id = operation.owner_id
            AND version.document_id = operation.document_id
            AND version.id = operation.target_version_id
          WHERE operation.owner_id = $1 AND operation.id = $2`,
        [envelope.ownerId, envelope.operationId],
      )
      if (rows.length !== 1) deny('SERVICE_UNAVAILABLE')
      const version = rows[0] as {
        format: string
        bucket: string
        oss_key: string
        file_hash: string
        size_bytes: string
      }
      if (version.format !== 'txt' && version.format !== 'md') deny('NOT_CONFIGURED')
      const revision = version.format === 'md' ? markdownParserRevision : textParserRevision
      const context = await claimBuild(transaction, job, envelope, {
        indexProfileId: config.indexProfileId ?? '',
        parserRevision: revision,
        parserSnapshot: {},
      })
      const intent = await recordEmbeddingIntent(transaction, {
        eventId: randomUUID(),
        attemptId: envelope.buildId,
        indexProfileId: context.indexProfileId,
        purpose: 'document',
        subject: { kind: 'operation', buildId: envelope.buildId },
      })
      return {
        version: {
          format: version.format,
          bucket: version.bucket,
          ossKey: version.oss_key,
          fileHash: version.file_hash,
          sizeBytes: BigInt(version.size_bytes),
        } satisfies VersionFacts,
        revision,
        intentEventId: intent.event.id,
      }
    })
    if (signal.aborted) deny('CANCELLED')

    // 阶段2（无事务）：按版本行从 OSS 取源字节并核对哈希，再在受限线程内解析。
    const store = resolveStore(claimed.version.bucket)
    const bytes = await readVerifiedSource(
      store,
      { bucket: claimed.version.bucket, key: claimed.version.ossKey },
      { sizeBytes: claimed.version.sizeBytes, fileHash: claimed.version.fileHash },
      signal,
    )
    const parsed = (await (claimed.version.format === 'md'
      ? parseMarkdown({ bytes, sourceHash: claimed.version.fileHash }, PARSE_POLICY)
      : parseText({ bytes, sourceHash: claimed.version.fileHash }, PARSE_POLICY))) as {
      parserRevision: string
      coverage: { scope: 'document' | 'selection' }
      units: readonly { id: string; ordinal: number; kind: string; text: string; textHash: string; locator: unknown }[]
    }
    if (signal.aborted) deny('CANCELLED')
    if (parsed.parserRevision !== claimed.revision) deny('INVALID_REQUEST')

    const { chunks, chunkSources } = createKnowledgeBuildChunkizer(
      KNOWLEDGE_BUILD_CHUNK_MAX_CODE_POINTS,
      claimed.revision,
    )(parsed)
    const sourceUnits: BuildSourceUnitRow[] = parsed.units.map((unit) => ({
      id: knowledgeUnitUuid(unit.id),
      ordinal: unit.ordinal,
      type: unit.kind ?? 'paragraph',
      text: unit.text,
      textHash: Buffer.from(unit.textHash, 'hex'),
      locator: unit.locator,
      coverage: parsed.coverage,
      warnings: [],
    }))

    // 嵌入批次：provider_reported 汇总真实用量，任一调用缺 usage 即诚实降级 unknown。
    const embeddings: BuildEmbeddingRow[] = []
    let callState: EmbeddingResultRequest['callState'] = 'not_called'
    let usage: EmbeddingResultRequest['usage'] = {
      source: 'reconciled',
      quantity: { unit: 'tokens', value: '0' },
    }
    if (config.embedding) {
      if (config.embedding.dimensions !== 1024) deny('NOT_CONFIGURED')
      const client = createDashscopeEmbeddingClient(config.embedding, { fetch: fetchImpl })
      let totalTokens = 0n
      let unknownUsage = false
      try {
        for (let start = 0; start < chunks.length; start += config.embedding.batchSize) {
          if (signal.aborted) deny('CANCELLED')
          const batch = chunks.slice(start, start + config.embedding.batchSize)
          const call = await client(batch.map((chunk) => chunk.text))
          if (call.vectors.length !== batch.length) deny('SERVICE_UNAVAILABLE')
          if (call.usageTokens === null) unknownUsage = true
          else totalTokens += BigInt(call.usageTokens)
          batch.forEach((chunk, index) => {
            embeddings.push({
              chunkId: chunk.id,
              embedding: JSON.stringify(call.vectors[index]),
              embeddedTextHash: chunk.textHash,
            })
          })
        }
      } catch (error) {
        // 先在同一事务内把 attempt 记账为 failed，再把可重试码交给队列。
        await database
          .transaction(principal(envelope.ownerId), async (transaction) => {
            await recordEmbeddingResult(transaction, {
              eventId: randomUUID(),
              attemptId: envelope.buildId,
              callState: 'failed',
              usage: { source: 'unknown', quantity: null },
            })
          })
          .catch(() => undefined)
        mapProviderError(error)
      }
      callState = 'completed'
      usage = unknownUsage
        ? { source: 'unknown', quantity: null }
        : {
            source: 'provider_reported',
            quantity: { unit: 'tokens', value: totalTokens.toString() },
          }
    }
    if (signal.aborted) deny('CANCELLED')

    // T2 内容事务：嵌入结果记账 → 受控内容写入 → 受控封存（manifest哈希/计数 DB 端实况计算）。
    await database.transaction(principal(envelope.ownerId), async (transaction) => {
      await recordEmbeddingResult(transaction, {
        eventId: randomUUID(),
        attemptId: envelope.buildId,
        callState,
        usage,
      })
      const content: BuildContent = { sourceUnits, chunks, chunkSources, embeddings }
      await writeBuildContent(transaction, { ownerId: envelope.ownerId, buildId: envelope.buildId }, content)
      await sealBuild(
        transaction,
        { ownerId: envelope.ownerId, buildId: envelope.buildId },
        {
          schemaVersion: 1,
          format: claimed.version.format,
          parserRevision: claimed.revision,
          sourceHash: claimed.version.fileHash,
          chunkBudgetCodePoints: KNOWLEDGE_BUILD_CHUNK_MAX_CODE_POINTS,
        },
        { now: new Date(now()) },
      )
    })
    if (signal.aborted) deny('CANCELLED')

    // T3 发布事务：信封协议复核 + job 完成结算 + 版本发布，同一事务提交。
    await database.transaction(principal(envelope.ownerId), (transaction) =>
      publishQueuedBuild(transaction, config.queueName!, job, envelope),
    )
  }
}