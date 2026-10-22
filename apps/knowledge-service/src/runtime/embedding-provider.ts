import { deny } from '../errors'
import { isLoopback, setting, type KnowledgeEnvironment } from './config-values'

// DashScope兼容端点嵌入适配器：配置解析与真实调用分开，fetch注入可测。
// 用量必须来自供应商回包（provider_reported），缺失时如实返回null（未知成本），
// 由调用侧决定台账里的callState与更正路径，绝不本地估算成本。

export interface KnowledgeEmbeddingProviderConfig {
  readonly baseUrl: string
  readonly model: string
  readonly dimensions: number
  readonly timeoutMs: number
  readonly batchSize: number
  readonly apiKey: string
}

export function parseKnowledgeEmbeddingProviderConfig(env: KnowledgeEnvironment) {
  const keys = ['BASE_URL', 'MODEL', 'DIMENSIONS', 'TIMEOUT_MS', 'BATCH_SIZE', 'API_KEY'] as const
  if (keys.every((key) => env[`KNOWLEDGE_EMBEDDING_${key}`] === undefined)) return undefined
  const baseUrl = setting(env.KNOWLEDGE_EMBEDDING_BASE_URL, 512)
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    deny('NOT_CONFIGURED')
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    deny('NOT_CONFIGURED')
  const positive = (value: string | undefined, maximum: number) => {
    const text = setting(value, 5)
    if (!/^[1-9][0-9]*$/.test(text) || Number(text) > maximum) deny('NOT_CONFIGURED')
    return Number(text)
  }
  const model = setting(env.KNOWLEDGE_EMBEDDING_MODEL, 128)
  const dimensions = positive(env.KNOWLEDGE_EMBEDDING_DIMENSIONS, 4096)
  const timeoutMs = positive(env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS, 60000)
  // DashScope兼容端点单请求批上限为10，与准备好的源配置一致。
  const batchSize = positive(env.KNOWLEDGE_EMBEDDING_BATCH_SIZE, 10)
  const apiKey = setting(env.KNOWLEDGE_EMBEDDING_API_KEY, 4096)
  return Object.freeze({
    baseUrl: url.href.replace(/\/+$/, ''),
    model,
    dimensions,
    timeoutMs,
    batchSize,
    apiKey,
  })
}

export type KnowledgeEmbeddingProviderErrorCode =
  'provider_rejected' | 'provider_unavailable' | 'provider_malformed'

// provider故障不是用户可见的拒绝，错误码不走共享契约联合；
// message只含稳定码，绝不携带密钥或响应正文。
export class KnowledgeEmbeddingProviderError extends Error {
  constructor(readonly code: KnowledgeEmbeddingProviderErrorCode) {
    super(code)
    this.name = 'KnowledgeEmbeddingProviderError'
  }
}

function providerDeny(code: KnowledgeEmbeddingProviderErrorCode): never {
  throw new KnowledgeEmbeddingProviderError(code)
}

export interface KnowledgeEmbeddingCallResult {
  readonly vectors: readonly (readonly number[])[]
  readonly usageTokens: number | null
  readonly requestId: string
}

export function createDashscopeEmbeddingClient(
  config: KnowledgeEmbeddingProviderConfig,
  dependencies: { fetch: typeof globalThis.fetch },
) {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`
  return async function embed(texts: readonly string[]): Promise<KnowledgeEmbeddingCallResult> {
    if (
      texts.length < 1 ||
      texts.length > config.batchSize ||
      texts.some((text) => typeof text !== 'string' || !text)
    )
      deny('INVALID_REQUEST')
    let response: Response
    try {
      response = await dependencies.fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          input: [...texts],
          dimensions: config.dimensions,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch {
      // 网络错误与超时一视同仁：可重试的供应商不可用，由调用侧按重试策略收敛。
      providerDeny('provider_unavailable')
    }
    if (!response.ok)
      providerDeny(response.status < 500 ? 'provider_rejected' : 'provider_unavailable')
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      providerDeny('provider_malformed')
    }
    const record = payload as { data?: unknown; usage?: { total_tokens?: unknown }; id?: unknown }
    if (!Array.isArray(record.data) || record.data.length !== texts.length)
      providerDeny('provider_malformed')
    const vectors = record.data.map((item) => {
      const candidate = (item as { embedding?: unknown } | null)?.embedding
      if (
        !Array.isArray(candidate) ||
        candidate.length !== config.dimensions ||
        !candidate.every((value) => typeof value === 'number' && Number.isFinite(value))
      )
        providerDeny('provider_malformed')
      return Object.freeze(candidate as number[])
    })
    const total = record.usage?.total_tokens
    const usageTokens =
      typeof total === 'number' &&
      Number.isInteger(total) &&
      total >= 0 &&
      total <= Number.MAX_SAFE_INTEGER
        ? total
        : null
    const requestIdFromBody =
      typeof record.id === 'string' && record.id.length <= 128 ? record.id : ''
    const headerRequestId = response.headers.get('x-dashscope-request-id') ?? ''
    const requestId = requestIdFromBody || (headerRequestId.length <= 128 ? headerRequestId : '')
    return Object.freeze({
      vectors: Object.freeze(vectors),
      usageTokens,
      requestId,
    })
  }
}
