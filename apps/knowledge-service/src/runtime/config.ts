import { deny } from '../errors'
import { parseKnowledgeQuantity } from '@genoffice/knowledge-contract'
import { dedicatedDatabase } from './database-config'
import { isLoopback, port, setting, type KnowledgeEnvironment } from './config-values'
import { parseKnowledgeEmbeddingProviderConfig } from './embedding-provider'
import { parseKnowledgeOssUploadConfig } from './oss-upload-config'
import { parseUploadHttpCompletionConfig } from './upload-http-config'

function uploadPolicy(env: KnowledgeEnvironment) {
  if (env.KNOWLEDGE_UPLOAD_MAXIMUM_FILE_BYTES === undefined) return undefined
  const maximumFileBytes = BigInt(
    parseKnowledgeQuantity({
      unit: 'bytes',
      value: env.KNOWLEDGE_UPLOAD_MAXIMUM_FILE_BYTES,
    }).value,
  )
  if (maximumFileBytes === 0n) deny('NOT_CONFIGURED')
  return Object.freeze({ maximumFileBytes })
}

function authenticationConfig(env: KnowledgeEnvironment, isolated: boolean) {
  const issuer = setting(env.KNOWLEDGE_AUTH_ISSUER, 2048)
  const audience = setting(env.KNOWLEDGE_AUTH_AUDIENCE)
  const url = new URL(issuer)
  if (
    (url.protocol !== 'https:' &&
      !(isolated && url.protocol === 'http:' && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (issuer !== url.href && issuer !== url.origin)
  )
    deny('NOT_CONFIGURED')
  const scopes = env.KNOWLEDGE_AUTH_REQUIRED_SCOPES ?? ''
  const requiredPermissions = scopes === '' ? [] : scopes.split(' ')
  if (
    requiredPermissions.length > 32 ||
    new Set(requiredPermissions).size !== requiredPermissions.length ||
    requiredPermissions.some((scope) => !/^[a-zA-Z][a-zA-Z0-9:_-]{0,127}$/.test(scope))
  )
    deny('NOT_CONFIGURED')
  return Object.freeze({
    issuer,
    audience,
    requiredPermissions,
    jwksUrl: `${issuer.replace(/\/$/, '')}/jwks`,
  })
}

// worker管线各配置项独立可选：缺席则键不存在，handler层面如实拒绝，绝不默认兜底。
function workerQueueName(env: KnowledgeEnvironment) {
  const value = env.KNOWLEDGE_UPLOAD_COMPLETION_QUEUE
  if (value === undefined) return undefined
  const queueName = setting(value, 63)
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(queueName)) deny('NOT_CONFIGURED')
  return queueName
}

function workerIndexProfileId(env: KnowledgeEnvironment) {
  const value = env.KNOWLEDGE_WORKER_INDEX_PROFILE_ID
  if (value === undefined) return undefined
  const id = setting(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    deny('NOT_CONFIGURED')
  return id
}

// IMDS 凭证路径的 OSS 区域（桶来自版本行）；仅当未配静态 STS 源时才需要。
function workerOssRegion(env: KnowledgeEnvironment) {
  const value = env.KNOWLEDGE_WORKER_OSS_REGION
  if (value === undefined) return undefined
  const region = setting(value, 64)
  if (!/^[a-z]{2}(?:-[a-z0-9]+){1,4}$/.test(region) || region.endsWith('-internal'))
    deny('NOT_CONFIGURED')
  return region
}

export function parseKnowledgeRuntimeConfig(env: KnowledgeEnvironment, role: 'api' | 'worker') {
  try {
    if (role !== 'api' && role !== 'worker') deny('NOT_CONFIGURED')
    const environment = env.KNOWLEDGE_ENVIRONMENT ?? 'production'
    if (environment !== 'production' && environment !== 'isolated_test') deny('NOT_CONFIGURED')
    const isolated = environment === 'isolated_test'
    const database = dedicatedDatabase(env, role, isolated)
    if (role === 'worker') {
      const queueName = workerQueueName(env)
      const auth = !env.KNOWLEDGE_AUTH_ISSUER ? undefined : authenticationConfig(env, isolated)
      const ossSource = parseKnowledgeOssUploadConfig(env)
      const embedding = parseKnowledgeEmbeddingProviderConfig(env)
      const indexProfileId = workerIndexProfileId(env)
      const ossRegion = workerOssRegion(env)
      return Object.freeze({
        role: 'worker' as const,
        environment,
        database,
        ...(queueName === undefined ? {} : { queueName }),
        ...(auth === undefined ? {} : { auth }),
        ...(ossSource === undefined ? {} : { ossSource }),
        ...(embedding === undefined ? {} : { embedding }),
        ...(indexProfileId === undefined ? {} : { indexProfileId }),
        ...(ossRegion === undefined ? {} : { ossRegion }),
      })
    }
    const host = setting(env.KNOWLEDGE_API_HOST ?? '127.0.0.1')
    if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host) || (isolated && !isLoopback(host)))
      deny('NOT_CONFIGURED')
    const policy = uploadPolicy(env)
    const authorization = parseKnowledgeOssUploadConfig(env)
    const completion = parseUploadHttpCompletionConfig(env, policy?.maximumFileBytes)
    if (completion && !authorization) deny('NOT_CONFIGURED')
    return Object.freeze({
      role: 'api' as const,
      environment,
      database,
      auth: authenticationConfig(env, isolated),
      deletionJournal: setting(env.KNOWLEDGE_DELETION_JOURNAL_DIR, 2048),
      uploadPolicy: policy,
      uploadAuthorization: authorization,
      uploadCompletion: completion,
      listen: { host, port: port(env.KNOWLEDGE_API_PORT ?? '4180', isolated) },
    })
  } catch {
    // URL/parser errors can contain a credential-bearing DSN; expose only the stable configuration code.
    deny('NOT_CONFIGURED')
  }
}

export type KnowledgeRuntimeConfig = ReturnType<typeof parseKnowledgeRuntimeConfig>
export type KnowledgeApiConfig = Extract<KnowledgeRuntimeConfig, { role: 'api' }>
export type KnowledgeWorkerConfig = Extract<KnowledgeRuntimeConfig, { role: 'worker' }>
