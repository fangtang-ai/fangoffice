import { deny } from './errors'

export interface KnowledgeAuthority {
  issuer: string
  audience: string
  requiredPermissions?: readonly string[]
}

export interface KnowledgeTrustedIdentity {
  issuer: string
  audiences: readonly string[]
  subject: string
  expiresAt: number
  permissions: readonly string[]
}

const principals = new WeakSet<object>()

export function requireServerTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) deny('SERVICE_UNAVAILABLE')
}

export function createKnowledgePrincipal(
  identity: KnowledgeTrustedIdentity | null,
  authority: KnowledgeAuthority,
  now: number,
) {
  requireServerTime(now)
  if (!authority.issuer?.trim() || !authority.audience?.trim()) deny('NOT_CONFIGURED')
  if (
    !identity ||
    identity.issuer !== authority.issuer ||
    !Array.isArray(identity.audiences) ||
    !identity.audiences.includes(authority.audience) ||
    !Array.isArray(identity.permissions) ||
    !(authority.requiredPermissions ?? []).every((permission) =>
      identity.permissions.includes(permission),
    ) ||
    typeof identity.subject !== 'string' ||
    !identity.subject ||
    identity.subject.length > 512 ||
    identity.subject.trim() !== identity.subject ||
    /\p{Cc}/u.test(identity.subject) ||
    !Number.isSafeInteger(identity.expiresAt) ||
    identity.expiresAt <= now
  )
    deny('UNAUTHENTICATED')
  // This is a pure-policy boundary, not a JWT verifier: only an authentication adapter supplies identity.
  const principal = Object.freeze({
    ownerId: identity.subject,
    issuer: identity.issuer,
    expiresAt: identity.expiresAt,
  })
  principals.add(principal)
  return principal
}

export type KnowledgePrincipal = ReturnType<typeof createKnowledgePrincipal>

export function requireKnowledgePrincipal(principal: KnowledgePrincipal, now: number) {
  requireServerTime(now)
  if (!principals.has(principal) || principal.expiresAt <= now) deny('UNAUTHENTICATED')
  return principal
}
