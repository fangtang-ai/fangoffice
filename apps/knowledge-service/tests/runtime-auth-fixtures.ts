import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { now } from './fixtures'
import { apiConfig } from './runtime-fixtures'

const keys = await generateKeyPair('RS256')
export const publicKeySet = {
  keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'synthetic-key', alg: 'RS256', use: 'sig' }],
}

export async function accessToken(claims: JWTPayload = {}, header: Record<string, string> = {}) {
  const config = apiConfig()
  return new SignJWT({
    iss: config.auth.issuer,
    aud: config.auth.audience,
    sub: 'synthetic-owner-A',
    iat: now / 1000,
    exp: now / 1000 + 60,
    scope: 'knowledge:access',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key', ...header })
    .sign(keys.privateKey)
}
