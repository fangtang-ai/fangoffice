import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { parseKnowledgeTextDocument } from '../src/parsing/text-document'
import { parseKnowledgeMarkdownDocument } from '../src/parsing/markdown-document'
import {
  createKnowledgeBuildHandler,
  KNOWLEDGE_BUILD_CHUNK_MAX_CODE_POINTS,
  type KnowledgeBuildHandlerDeps,
} from '../src/runtime/build-handler'
import type { KnowledgeWorkerConfig } from '../src/runtime/config'
import type { KnowledgePrincipal } from '../src/identity'
import type { KnowledgeTransaction } from '../src/runtime/transaction'

const OWNER = 'owner-a'
const DOCUMENT_ID = 'd1a7c0de-0000-4000-8000-000000000001'
const VERSION_ID = 'd1a7c0de-0000-4000-8000-000000000002'
const OPERATION_ID = 'd1a7c0de-0000-4000-8000-000000000003'
const BUILD_ID = 'd1a7c0de-0000-4000-8000-000000000004'
const RECEIPT_ID = 'd1a7c0de-0000-4000-8000-000000000005'
const PROFILE_ID = 'd1a7c0de-0000-4000-8000-000000000006'
const SPACE_ID = 'd1a7c0de-0000-4000-8000-000000000007'
const EVENT_ID = 'd1a7c0de-0000-4000-8000-000000000008'

const CONTENT = 'hello 方塘\nsecond line\n'
const CONTENT_BYTES = Buffer.from(CONTENT, 'utf8')
const CONTENT_HASH = createHash('sha256').update(CONTENT_BYTES).digest('hex')

function workerConfig(overrides: Partial<KnowledgeWorkerConfig> = {}): KnowledgeWorkerConfig {
  return {
    role: 'worker',
    environment: 'isolated_test',
    database: {},
    queueName: 'knowledge_builds',
    auth: {
      issuer: 'https://issuer.example',
      audience: 'knowledge',
      requiredPermissions: [],
      jwksUrl: 'https://issuer.example/jwks',
    },
    ossRegion: 'cn-hangzhou',
    ...overrides,
  } as unknown as KnowledgeWorkerConfig
}

function ossResponse(body: Buffer | Uint8Array) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-length': String(body.byteLength),
      etag: '"stable"',
      'content-type': 'text/plain',
    },
  })
}

interface CapturedCall {
  statement: string
  values: unknown[]
}

function createFakeDatabase() {
  const calls: CapturedCall[] = []
  const routing = new Map<RegExp, (call: CapturedCall) => unknown[]>()

  const route = (statement: string, values: unknown[]) => {
    calls.push({ statement, values })
    for (const [pattern, handler] of routing) {
      if (pattern.test(statement)) return handler({ statement, values })
    }
    throw new Error(`TRANSCRIPT_END: ${statement.slice(0, 60)}`)
  }

  const transactionLog: string[] = []
  const database = {
    calls,
    transactionLog,
    async transaction<Result>(
      principal: KnowledgePrincipal,
      work: (transaction: KnowledgeTransaction) => Promise<Result>,
    ) {
      assert.equal(principal.ownerId, OWNER)
      const begin = calls.length
      const result = await work({
        async query(statement: string, values?: unknown[]) {
          return { rows: route(statement, values ?? []) ?? [], rowCount: null }
        },
      })
      transactionLog.push(`tx[${begin}..${calls.length}]`)
      return result
    },
  }
  return { database, calls, transactionLog, routing }
}

function intentEventRow() {
  return {
    schema_version: 1,
    id: EVENT_ID,
    logical_event_key: `embedding/document/${BUILD_ID}`,
    occurred_at: new Date().toISOString(),
    event_type: 'observation',
    supersedes_event_id: null,
    tariff_revision: null,
    payer: 'platform',
    dimension: 'embedding',
    subject_kind: 'operation',
    space_id: SPACE_ID,
    document_id: DOCUMENT_ID,
    version_id: VERSION_ID,
    operation_id: OPERATION_ID,
    build_id: BUILD_ID,
    run_id: null,
    call_id: null,
    attempt_id: BUILD_ID,
    index_profile_id: PROFILE_ID,
    purpose: 'document',
    call_state: 'intended',
    completion: 'none',
    usage_source: 'unknown',
    unit: 'tokens',
    quantity: null,
  }
}

function installDefaultRoutes(
  database: ReturnType<typeof createFakeDatabase>,
  format = 'txt',
  fileHash = CONTENT_HASH,
  sizeBytes = CONTENT_BYTES.byteLength,
) {
  const { routing } = database
  routing.set(/JOIN knowledge\.kb_versions version/, () => [
    {
      version_id: VERSION_ID,
      format,
      bucket: 'bucket-a',
      oss_key: `originals/${'a'.repeat(64)}/${DOCUMENT_ID}/${OPERATION_ID}`,
      file_hash: fileHash,
      size_bytes: String(sizeBytes),
    },
  ])
  routing.set(/FROM knowledge\.kb_operations\n/, () => [
    {
      phase: 'queued',
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
      expected_generation: '1',
      current_build_id: null,
      current_job_id: null,
      current_retry_count: null,
    },
  ])
  routing.set(/FROM knowledge\.kb_index_profiles/, () => [{ ok: 1 }])
  routing.set(/FROM knowledge\.kb_builds\s+WHERE owner_id = \$1 AND id = \$2/, () => [])
  routing.set(/INSERT INTO knowledge\.kb_builds/, () => [])
  routing.set(/knowledge\.bind_operation_attempt/, () => [{ status: 'BOUND' }])
  routing.set(/FROM knowledge\.kb_builds b/, () => [
    {
      build_id: BUILD_ID,
      operation_id: OPERATION_ID,
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
      index_profile_id: PROFILE_ID,
      status: 'building',
      gc_state: 'live',
      expected_generation: '1',
      operation_kind: 'upload',
      operation_phase: 'queued',
      current_attempt: true,
      receipt_status: 'pending',
    },
  ])
  routing.set(/knowledge\.record_embedding_event/, () => [{ status: 'RECORDED' }])
  routing.set(/FROM knowledge\.kb_metering_events/, () => [
    { current: intentEventRow(), previous: null },
  ])
  for (const table of ['kb_source_units', 'kb_chunks', 'kb_chunk_sources', 'kb_chunk_embeddings']) {
    routing.set(new RegExp(`INSERT INTO knowledge\\.${table}`), () => [])
  }
  routing.set(/knowledge\.seal_locked_build/, () => [{ status: 'SEALED' }])
  routing.set(/knowledge\.lock_build_lifecycle/, () => [{ status: 'LOCKED' }])
  routing.set(/SELECT id FROM pgboss\.job_common WHERE name = \$1 AND id = \$2 FOR UPDATE/, () => [
    { id: 'job-1' },
  ])
  routing.set(/SELECT data FROM pgboss\.job_common/, () => [
    {
      data: {
        ownerId: OWNER,
        operationId: OPERATION_ID,
        buildId: BUILD_ID,
        receiptId: RECEIPT_ID,
      },
    },
  ])
  routing.set(/pgboss/, () => [{ count: '1' }])
  routing.set(/knowledge\.publish_reserved_build/, () => [{ status: 'PUBLISHED' }])
}

function handlerDeps(
  overrides: Partial<KnowledgeBuildHandlerDeps> = {},
): KnowledgeBuildHandlerDeps {
  return {
    fetch: undefined,
    now: () => 1730000000000,
    credentialSource: {
      async get() {
        return {
          accessKeyId: 'sts-access-key-id',
          accessKeySecret: 'sts-access-key-secret',
          securityToken: 'sts-security-token',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        }
      },
    },
    parseText: async (value, policy) => parseKnowledgeTextDocument(value, policy),
    parseMarkdown: async (value, policy) => parseKnowledgeMarkdownDocument(value, policy),
    ...overrides,
  }
}

function job() {
  return { id: 'job-1', retryCount: 1 }
}

function envelope() {
  return { ownerId: OWNER, operationId: OPERATION_ID, buildId: BUILD_ID, receiptId: RECEIPT_ID }
}

function embeddingConfig() {
  return {
    baseUrl: 'https://dashscope.example/compatible-mode/v1',
    model: 'text-embedding-v4',
    dimensions: 1024,
    timeoutMs: 1000,
    batchSize: 10,
    apiKey: 'sk-test',
  }
}

function fetchFor(content: Buffer, vectors: readonly number[][]) {
  return async (input: unknown) => {
    const url = String(input instanceof URL ? input.href : input)
    if (url.includes('.aliyuncs.com/')) return ossResponse(content)
    // undici 类型层拒绝 Request，但运行时 Response 构造器接受它（读 body）
    const body = input instanceof Request ? (input as unknown as string) : String(input)
    const payload = (await new Response(body).json().catch(() => undefined)) as { input?: unknown } | undefined
    assert.ok(payload && Array.isArray(payload.input))
    return Response.json({
      id: 'resp-1',
      data: payload.input.map((_: unknown, index: number) => ({ embedding: vectors[index] })),
      usage: { total_tokens: 42 },
    })
  }
}

describe('createKnowledgeBuildHandler', () => {
  it('exports the locked chunk budget', () => {
    assert.equal(KNOWLEDGE_BUILD_CHUNK_MAX_CODE_POINTS, 2000)
  })

  it('denies at job time without authority config', async () => {
    const fake = createFakeDatabase()
    installDefaultRoutes(fake)
    const handler = createKnowledgeBuildHandler(
      fake.database as never,
      workerConfig({ auth: undefined }),
      handlerDeps(),
    )
    await assert.rejects(
      handler({ job: job(), envelope: envelope(), signal: new AbortController().signal }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'NOT_CONFIGURED',
    )
    assert.equal(fake.calls.length, 0)
  })

  it('denies unsupported version formats before touching OSS', async () => {
    const fake = createFakeDatabase()
    installDefaultRoutes(fake, 'pdf')
    const handler = createKnowledgeBuildHandler(fake.database as never, workerConfig(), handlerDeps())
    await assert.rejects(
      handler({ job: job(), envelope: envelope(), signal: new AbortController().signal }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'NOT_CONFIGURED',
    )
    assert.equal(fake.calls.some((call) => call.statement.includes('record_embedding_event')), false)
  })

  it('runs claim→read→parse→chunk→embed→write→seal→publish for txt', async () => {
    const fake = createFakeDatabase()
    installDefaultRoutes(fake)
    const vectors = [[...Array(1024).keys()].map((value) => value / 4096)]
    const fetchCalls: string[] = []
    const deps = handlerDeps({
      fetch: (async (input: unknown, init?: { body?: unknown }) => {
        const url = String(input instanceof URL ? input.href : input)
        fetchCalls.push(url)
        if (url.includes('.aliyuncs.com/')) return ossResponse(CONTENT_BYTES)
        const payload = JSON.parse(String(init?.body)) as { input: unknown[] }
        return Response.json({
          id: 'resp-1',
          data: payload.input.map((_: unknown, index: number) => ({ embedding: vectors[index] })),
          usage: { total_tokens: 42 },
        })
      }) as never,
    })
    const handler = createKnowledgeBuildHandler(
      fake.database as never,
      workerConfig({ embedding: embeddingConfig() as never }),
      deps,
    )
    await handler({ job: job(), envelope: envelope(), signal: new AbortController().signal })
    const statements = fake.calls.map((call) => call.statement)
    const indexOf = (needle: string) => statements.findIndex((statement) => statement.includes(needle))
    const version = indexOf('JOIN knowledge.kb_versions version')
    const intent = indexOf('record_embedding_event')
    const result = statements.findIndex(
      (statement, index) => statement.includes('record_embedding_event') && index > intent,
    )
    const sourceUnits = indexOf('INSERT INTO knowledge.kb_source_units')
    const chunks = indexOf('INSERT INTO knowledge.kb_chunks')
    const chunkSources = indexOf('INSERT INTO knowledge.kb_chunk_sources')
    const embeddings = indexOf('INSERT INTO knowledge.kb_chunk_embeddings')
    const seal = indexOf('seal_locked_build')
    assert.equal(fetchCalls.length, 2)
    assert.ok(fetchCalls[0]!.startsWith('https://bucket-a.oss-cn-hangzhou.aliyuncs.com/originals/'))
    assert.ok(fetchCalls[1]!.startsWith('https://dashscope.example/'))
    assert.ok(version >= 0 && intent > version && result > intent)
    assert.ok(chunks > sourceUnits && chunkSources > chunks && embeddings > chunkSources)
    assert.ok(seal > embeddings)

    const resultCall = fake.calls[result]!
    assert.deepEqual(resultCall.values.slice(2, 5), ['completed', 'provider_reported', '42'])
    const chunkRow = fake.calls[chunks]!.values
    assert.equal(chunkRow[6], 0)
    assert.equal(chunkRow[7], '')
    assert.ok(Buffer.isBuffer(chunkRow[5]))
    const unitRow = fake.calls[sourceUnits]!.values
    assert.equal(unitRow[5], 'line')
    assert.equal(unitRow[10], '[]')
    const sourceRow = fake.calls[chunkSources]!.values
    assert.equal(sourceRow[3], 0)
    assert.equal(sourceRow[4], unitRow[2])
    assert.equal(sourceRow[5], 0)
    const embeddingRow = fake.calls[embeddings]!.values
    assert.equal(embeddingRow[3], JSON.stringify(vectors[0]))
    assert.deepEqual(embeddingRow[4], chunkRow[5])
    const sealManifest = JSON.parse(fake.calls[seal]!.values[2] as string) as Record<string, unknown>
    assert.equal(sealManifest.format, 'txt')
    assert.equal(sealManifest.chunkBudgetCodePoints, 2000)
    assert.equal(sealManifest.sourceHash, CONTENT_HASH)
  })

  it('records honest not_called usage when embedding is not configured', async () => {
    const fake = createFakeDatabase()
    installDefaultRoutes(fake)
    let ossFetches = 0
    const deps = handlerDeps({
      fetch: (async (input: unknown) => {
        const url = String(input instanceof URL ? input.href : input)
        if (url.includes('.aliyuncs.com/')) {
          ossFetches += 1
          return ossResponse(CONTENT_BYTES)
        }
        throw new Error('unexpected provider call')
      }) as never,
    })
    const handler = createKnowledgeBuildHandler(fake.database as never, workerConfig(), deps)
    await handler({ job: job(), envelope: envelope(), signal: new AbortController().signal })
    const statements = fake.calls.map((call) => call.statement)
    const intents = statements.filter((statement) => statement.includes('record_embedding_event'))
    assert.equal(intents.length, 2)
    assert.equal(ossFetches, 1)
    assert.equal(fake.calls.some((call) => call.statement.includes('kb_chunk_embeddings')), false)
    const result = fake.calls.filter((call) => call.statement.includes('record_embedding_event')).at(-1)!
    assert.deepEqual(result.values.slice(2, 5), ['not_called', 'reconciled', '0'])
  })

  it('rejects a source whose bytes no longer match the version hash', async () => {
    const fake = createFakeDatabase()
    installDefaultRoutes(fake)
    const deps = handlerDeps({
      fetch: (async () => ossResponse(Buffer.from('tampered bytes', 'utf8'))) as never,
    })
    const handler = createKnowledgeBuildHandler(fake.database as never, workerConfig(), deps)
    await assert.rejects(
      handler({ job: job(), envelope: envelope(), signal: new AbortController().signal }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'INVALID_REQUEST',
    )
    assert.equal(fake.calls.some((call) => call.statement.includes('INSERT INTO knowledge.kb_chunks')), false)
  })

  it('records a failed embedding attempt before surfacing provider failures', async () => {
    const fake = createFakeDatabase()
    installDefaultRoutes(fake)
    const deps = handlerDeps({
      fetch: (async (input: unknown) => {
        const url = String(input instanceof URL ? input.href : input)
        if (url.includes('.aliyuncs.com/')) return ossResponse(CONTENT_BYTES)
        return new Response('upstream exploded', { status: 502 })
      }) as never,
    })
    const handler = createKnowledgeBuildHandler(
      fake.database as never,
      workerConfig({ embedding: embeddingConfig() as never }),
      deps,
    )
    await assert.rejects(
      handler({ job: job(), envelope: envelope(), signal: new AbortController().signal }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'SERVICE_UNAVAILABLE',
    )
    const statements = fake.calls.map((call) => call.statement)
    assert.equal(statements.filter((statement) => statement.includes('record_embedding_event')).length, 2)
    assert.equal(fake.calls.some((call) => call.statement.includes('INSERT INTO knowledge.kb_chunks')), false)
    const failed = fake.calls.filter((call) => call.statement.includes('record_embedding_event')).at(-1)!
    assert.deepEqual(failed.values.slice(2, 5), ['failed', 'unknown', null])
    assert.equal(failed.values[5], null, 'first result on the attempt carries no supersedes')
  })

  it('denies a dimensions mismatch against the fixed vector column', async () => {
    const fake = createFakeDatabase()
    installDefaultRoutes(fake)
    const handler = createKnowledgeBuildHandler(
      fake.database as never,
      workerConfig({ embedding: { ...embeddingConfig(), dimensions: 768 } as never }),
      handlerDeps({ fetch: fetchFor(CONTENT_BYTES, [[]]) }),
    )
    await assert.rejects(
      handler({ job: job(), envelope: envelope(), signal: new AbortController().signal }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'NOT_CONFIGURED',
    )
  })

  it('chunks markdown into source units with kind and heading locator mapping', async () => {
    const markdown = '# 甲\n\n正文段落。\n\n| 一 | 二 |\n| - | - |\n| 1 | 2 |\n'
    const markdownBytes = Buffer.from(markdown, 'utf8')
    const markdownHash = createHash('sha256').update(markdownBytes).digest('hex')
    const fake = createFakeDatabase()
    installDefaultRoutes(fake, 'md', markdownHash, markdownBytes.byteLength)
    const deps = handlerDeps({
      fetch: (async (input: unknown) => {
        const url = String(input instanceof URL ? input.href : input)
        if (url.includes('.aliyuncs.com/')) return ossResponse(markdownBytes)
        throw new Error('unexpected provider call')
      }) as never,
    })
    const handler = createKnowledgeBuildHandler(fake.database as never, workerConfig(), deps)
    await handler({ job: job(), envelope: envelope(), signal: new AbortController().signal })
    const unitTypes = fake.calls
      .filter((call) => call.statement.includes('INSERT INTO knowledge.kb_source_units'))
      .map((call) => call.values[5])
    assert.deepEqual(unitTypes, ['heading', 'paragraph', 'table'])
    const sealManifest = JSON.parse(
      fake.calls.find((call) => call.statement.includes('seal_locked_build'))!.values[2] as string,
    ) as Record<string, unknown>
    assert.equal(sealManifest.parserRevision, 'markdown-atx-blocks-v1')
    assert.equal(sealManifest.format, 'md')
  })
})