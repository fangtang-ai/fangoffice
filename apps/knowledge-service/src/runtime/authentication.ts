import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose'
import { deny, KnowledgePolicyError } from '../errors'
import { createKnowledgePrincipal, requireServerTime } from '../identity'
import type { KnowledgeApiConfig } from './config'
import { boundedJwksFetch } from './jwks-fetch'

export interface KnowledgeAuthenticationOptions {
  fetch?: typeof globalThis.fetch
  now?: () => number
  jwksTimeoutMs?: number
}

export function createKnowledgeAuthenticator(
  config: KnowledgeApiConfig['auth'],
  options: KnowledgeAuthenticationOptions = {},
) {
  const transport = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const timeout = options.jwksTimeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) deny('NOT_CONFIGURED')
  const keys = createRemoteJWKSet(new URL(config.jwksUrl), {
    timeoutDuration: timeout,
    [customFetch]: boundedJwksFetch(transport),
  })
  return async (authorization: unknown) => {
    if (typeof authorization !== 'string' || authorization.length > 8192) deny('UNAUTHENTICATED')
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization)
    if (!match) deny('UNAUTHENTICATED')
    try {
      const startedAt = now()
      requireServerTime(startedAt)
      const { payload } = await jwtVerify(match[1]!, keys, {
        algorithms: ['RS256'],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['sub', 'exp', 'iat'],
        currentDate: new Date(startedAt),
      })
      const current = now()
      requireServerTime(current)
      if (
        typeof payload.sub !== 'string' ||
        payload.iss !== config.issuer ||
        typeof payload.exp !== 'number' ||
        typeof payload.iat !== 'number' ||
        !Number.isFinite(payload.iat) ||
        payload.iat > current / 1000
      )
        deny('UNAUTHENTICATED')
      const scope = payload.scope
      if (
        scope !== undefined &&
        (typeof scope !== 'string' || scope.length > 4096 || /\p{Cc}/u.test(scope))
      )
        deny('UNAUTHENTICATED')
      const permissions = typeof scope === 'string' ? scope.split(' ').filter(Boolean) : []
      // Only verified resource-token claims cross into the pure-policy principal boundary.
      return createKnowledgePrincipal(
        {
          issuer: payload.iss,
          audiences: typeof payload.aud === 'string' ? [payload.aud] : (payload.aud ?? []),
          subject: payload.sub,
          expiresAt: payload.exp * 1000,
          permissions,
        },
        config,
        current,
      )
    } catch (error) {
      if (error instanceof KnowledgePolicyError) throw error
      if (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        error instanceof errors.JWKSMultipleMatchingKeys ||
        (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC')
      )
        deny('SERVICE_UNAVAILABLE')
      deny('UNAUTHENTICATED')
    }
  }
}
