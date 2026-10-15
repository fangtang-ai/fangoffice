import { expect, it } from 'vitest'
import { createKnowledgePrincipal } from '../src'

const now = Date.parse('2026-10-15T00:00:00.000Z')
const authority = {
  issuer: 'https://issuer.invalid/oidc',
  audience: 'https://account.invalid',
  requiredPermissions: ['knowledge:access'],
}
const verifiedIdentity = {
  issuer: authority.issuer,
  audiences: [authority.audience],
  subject: 'synthetic-owner-A',
  expiresAt: now + 60000,
  permissions: ['knowledge:access'],
}

it('derives a frozen principal only from the trusted authentication context', () => {
  const principal = createKnowledgePrincipal(verifiedIdentity, authority, now)
  expect(principal.ownerId).toBe('synthetic-owner-A')
  expect(Object.isFrozen(principal)).toBe(true)
})

it.each([
  null,
  { ...verifiedIdentity, issuer: 'https://other.invalid' },
  { ...verifiedIdentity, audiences: ['https://other.invalid'] },
  { ...verifiedIdentity, permissions: [] },
  { ...verifiedIdentity, subject: '' },
  { ...verifiedIdentity, subject: ' synthetic-owner-A' },
  { ...verifiedIdentity, subject: 'synthetic\u0000owner' },
  { ...verifiedIdentity, subject: 'synthetic\u0085owner' },
  { ...verifiedIdentity, expiresAt: now },
  { ...verifiedIdentity, expiresAt: NaN },
])('rejects absent, expired or mismatched trusted identity without exposing claims', (identity) => {
  expect(() => createKnowledgePrincipal(identity, authority, now)).toThrow('UNAUTHENTICATED')
})

it('fails closed for missing authority configuration or invalid server time', () => {
  expect(() =>
    createKnowledgePrincipal(verifiedIdentity, { ...authority, issuer: '' }, now),
  ).toThrow('NOT_CONFIGURED')
  expect(() => createKnowledgePrincipal(verifiedIdentity, authority, NaN)).toThrow(
    'SERVICE_UNAVAILABLE',
  )
})
