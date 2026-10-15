import { deny } from '../errors'
import { dedicatedDatabase } from './database-config'
import { isLoopback, port, setting, type KnowledgeEnvironment } from './config-values'

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

export function parseKnowledgeRuntimeConfig(env: KnowledgeEnvironment, role: 'api' | 'worker') {
  try {
    if (role !== 'api' && role !== 'worker') deny('NOT_CONFIGURED')
    const environment = env.KNOWLEDGE_ENVIRONMENT ?? 'production'
    if (environment !== 'production' && environment !== 'isolated_test') deny('NOT_CONFIGURED')
    const isolated = environment === 'isolated_test'
    const database = dedicatedDatabase(env, role, isolated)
    if (role === 'worker') return Object.freeze({ role: 'worker' as const, environment, database })
    const host = setting(env.KNOWLEDGE_API_HOST ?? '127.0.0.1')
    if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host) || (isolated && !isLoopback(host)))
      deny('NOT_CONFIGURED')
    return Object.freeze({
      role: 'api' as const,
      environment,
      database,
      auth: authenticationConfig(env, isolated),
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
