import { deny } from '../errors'

// ECS IMDS(v1)短期STS凭证源：仅供worker侧OSS读取注入凭据，凭证必须来自真实回包，
// 绝不本地伪造。缓存到到期前60秒，失败不缓存；并发刷新共享同一次请求（单飞）。

const DEFAULT_ENDPOINT = 'http://100.100.100.100'
const RENEWAL_MARGIN_MS = 60_000

export interface KnowledgeImdsCredentials {
  readonly accessKeyId: string
  readonly accessKeySecret: string
  readonly securityToken: string
  readonly expiresAt: string
}

export interface KnowledgeImdsCredentialSource {
  get(): Promise<KnowledgeImdsCredentials>
}

export interface KnowledgeImdsCredentialSourceOptions {
  readonly endpoint?: string
  readonly roleName?: string
  readonly fetch: typeof globalThis.fetch
  readonly now?: () => number
}

function boundedField(value: unknown, maximum: number): string {
  if (typeof value === 'string' && value.length >= 1 && value.length <= maximum) return value
  deny('SERVICE_UNAVAILABLE')
}

export function createKnowledgeImdsCredentialSource(
  options: KnowledgeImdsCredentialSourceOptions,
): KnowledgeImdsCredentialSource {
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
  const fetchImpl = options.fetch
  const now = options.now ?? Date.now
  let cached: { credentials: KnowledgeImdsCredentials; expiresAtMs: number } | undefined
  let inflight: Promise<KnowledgeImdsCredentials> | undefined

  async function discoverRoleName(): Promise<string> {
    if (options.roleName) return options.roleName
    let response: Response
    try {
      response = await fetchImpl(`${endpoint}/latest/meta-data/ram/security-credentials/`)
    } catch {
      deny('SERVICE_UNAVAILABLE')
    }
    if (!response.ok) deny('SERVICE_UNAVAILABLE')
    let name: string
    try {
      name = (await response.text()).trim()
    } catch {
      deny('SERVICE_UNAVAILABLE')
    }
    if (!name || name.length > 128 || /\s/.test(name)) deny('SERVICE_UNAVAILABLE')
    return name
  }

  async function refresh(): Promise<KnowledgeImdsCredentials> {
    const role = await discoverRoleName()
    let response: Response
    try {
      response = await fetchImpl(`${endpoint}/latest/meta-data/ram/security-credentials/${role}`)
    } catch {
      deny('SERVICE_UNAVAILABLE')
    }
    if (!response.ok) deny('SERVICE_UNAVAILABLE')
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      deny('SERVICE_UNAVAILABLE')
    }
    const record = payload as {
      AccessKeyId?: unknown
      AccessKeySecret?: unknown
      SecurityToken?: unknown
      Expiration?: unknown
    }
    const accessKeyId = boundedField(record.AccessKeyId, 256)
    const accessKeySecret = boundedField(record.AccessKeySecret, 256)
    const securityToken = boundedField(record.SecurityToken, 4096)
    const expiresAtText = boundedField(record.Expiration, 64)
    const expiresAtMs = Date.parse(expiresAtText)
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) deny('SERVICE_UNAVAILABLE')
    return Object.freeze({ accessKeyId, accessKeySecret, securityToken, expiresAt: expiresAtText })
  }

  return {
    async get() {
      const remaining = cached ? cached.expiresAtMs - now() : 0
      if (cached && remaining > RENEWAL_MARGIN_MS) return cached.credentials
      if (!inflight) {
        inflight = refresh().then(
          (credentials) => {
            cached = { credentials, expiresAtMs: Date.parse(credentials.expiresAt) }
            inflight = undefined
            return credentials
          },
          (error) => {
            inflight = undefined
            throw error
          },
        )
      }
      return inflight
    },
  }
}