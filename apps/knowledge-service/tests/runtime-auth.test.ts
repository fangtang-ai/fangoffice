import { expect, it, vi } from 'vitest'
import { generateKeyPair, SignJWT } from 'jose'
import { createKnowledgeAuthenticator } from '../src/runtime'
import { now } from './fixtures'
import { apiConfig } from './runtime-fixtures'
import { accessToken, publicKeySet } from './runtime-auth-fixtures'

function authentication() {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(publicKeySet))
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => now,
  })
  return { authenticate, transport }
}

it('verifies a resource token signature and derives owner only from its verified sub', async () => {
  const { authenticate } = authentication()
  const principal = await authenticate(`Bearer ${await accessToken({ ownerId: 'forged-owner' })}`)
  expect(principal.ownerId).toBe('synthetic-owner-A')
  expect(Object.isFrozen(principal)).toBe(true)
})

it.each([
  undefined,
  '',
  'Basic synthetic',
  'Bearer opaque-token',
  'Bearer a.b.c, Bearer d.e.f',
  'Bearer ' + 'x'.repeat(8193),
])('rejects malformed authentication before any key request', async (header) => {
  const { authenticate, transport } = authentication()
  await expect(authenticate(header)).rejects.toThrow('UNAUTHENTICATED')
  expect(transport).not.toHaveBeenCalled()
})

it.each([
  { iss: 'https://other.invalid/oidc' },
  { aud: 'synthetic-native-client-id' },
  { sub: '' },
  { exp: undefined },
  { exp: now / 1000 },
  { nbf: now / 1000 + 10 },
  { iat: now / 1000 + 10 },
  { scope: 'openid profile' },
  { scope: ['knowledge:access'] },
])('rejects a valid signature with invalid identity, time or permissions', async (claims) => {
  const { authenticate } = authentication()
  await expect(authenticate(`Bearer ${await accessToken(claims)}`)).rejects.toThrow(
    'UNAUTHENTICATED',
  )
})

it('rejects both a different private key and a tampered signature', async () => {
  const { authenticate } = authentication()
  const attacker = await generateKeyPair('RS256')
  const forged = await new SignJWT({ sub: 'synthetic-owner-A' })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .sign(attacker.privateKey)
  await expect(authenticate(`Bearer ${forged}`)).rejects.toThrow('UNAUTHENTICATED')
  const [header, payload, signature] = (await accessToken()).split('.')
  const tampered = `${header}.${payload}.${signature!.startsWith('A') ? 'B' : 'A'}${signature!.slice(1)}`
  await expect(authenticate(`Bearer ${tampered}`)).rejects.toThrow('UNAUTHENTICATED')
})

it('never accepts an HMAC or unsigned token under an asymmetric resource policy', async () => {
  const { authenticate } = authentication()
  const hmac = await new SignJWT({ sub: 'synthetic-owner-A' })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode('synthetic-hmac-key-not-a-resource-key'))
  await expect(authenticate(`Bearer ${hmac}`)).rejects.toThrow('UNAUTHENTICATED')
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.x`
  await expect(authenticate(`Bearer ${none}`)).rejects.toThrow('UNAUTHENTICATED')
})

it('pins JWKS lookup instead of following token jku, forwarding credentials or refetching per request', async () => {
  const { authenticate, transport } = authentication()
  const token = await accessToken({}, { jku: 'http://169.254.169.254/latest/credentials' })
  const results = await Promise.all(
    Array.from({ length: 5 }, () => authenticate(`Bearer ${token}`)),
  )
  expect(results.every((principal) => principal.ownerId === 'synthetic-owner-A')).toBe(true)
  expect(transport).toHaveBeenCalledOnce()
  const [url, init] = transport.mock.calls[0]!
  expect(String(url)).toBe('https://issuer.invalid/oidc/jwks')
  expect(init?.redirect).toBe('error')
  expect(init?.credentials).toBe('omit')
  expect(new Headers(init?.headers).has('Authorization')).toBe(false)
})

it('rechecks expiry after a slow key lookup instead of releasing an already-expired principal', async () => {
  let current = now
  let resolve!: (response: Response) => void
  const transport = vi.fn<typeof fetch>().mockReturnValue(
    new Promise<Response>((finish) => {
      resolve = finish
    }),
  )
  const authenticate = createKnowledgeAuthenticator(apiConfig().auth, {
    fetch: transport,
    now: () => current,
  })
  const request = authenticate(`Bearer ${await accessToken()}`)
  current += 61000
  resolve(Response.json(publicKeySet))
  await expect(request).rejects.toThrow('UNAUTHENTICATED')
})
