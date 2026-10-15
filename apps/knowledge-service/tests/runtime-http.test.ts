import { request as httpRequest } from 'node:http'
import { expect, it, vi } from 'vitest'
import { startKnowledgeApi } from '../src/runtime'
import { accessToken, publicKeySet } from './runtime-auth-fixtures'
import { localApiConfig, syntheticPool } from './runtime-service-fixtures'
import { now } from './fixtures'

async function serviceFixture() {
  const pool = syntheticPool()
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(publicKeySet))
  const service = await startKnowledgeApi(localApiConfig(), {
    poolFactory: () => pool,
    authentication: { fetch: transport, now: () => now },
    shutdownTimeoutMs: 100,
  })
  const headers = { Authorization: `Bearer ${await accessToken()}` }
  return { ...service, pool, transport, headers }
}

it('exposes bounded control endpoints but no CORS, credentials, database identity or business payload', async () => {
  const service = await serviceFixture()
  try {
    expect((await fetch(`${service.origin}/readyz`)).status).toBe(200)
    const unsupported = await fetch(`${service.origin}/api/knowledge/spaces`, {
      headers: service.headers,
    })
    expect(await unsupported.json()).toEqual({ code: 'NOT_FOUND', requestId: null })
    expect(unsupported.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(unsupported.headers.get('Set-Cookie')).toBeNull()
    for (const path of [
      '/api/knowledge/status?owner=forged',
      '/api/knowledge/%73tatus',
      '/unknown',
    ]) {
      expect((await fetch(`${service.origin}${path}`, { headers: service.headers })).status).toBe(
        404,
      )
    }
    expect(service.pool.query).toHaveBeenCalledOnce()
  } finally {
    await service.close()
  }
})

it('rejects methods and body-bearing requests without invoking authentication or a database transaction', async () => {
  const service = await serviceFixture()
  try {
    const method = await fetch(`${service.origin}/api/knowledge/status`, { method: 'PUT' })
    expect(method.status).toBe(405)
    expect(method.headers.get('Allow')).toBe('GET')
    const body = await fetch(`${service.origin}/api/knowledge/status`, {
      method: 'POST',
      body: 'synthetic-private-document',
    })
    expect(body.status).toBe(413)
    expect(await body.json()).toEqual({ code: 'INVALID_REQUEST', requestId: null })
    expect(service.transport).not.toHaveBeenCalled()
    expect(service.pool.query).toHaveBeenCalledOnce()
  } finally {
    await service.close()
  }
})

it('rejects duplicate bearer headers rather than relying on the HTTP parser to pick one', async () => {
  const service = await serviceFixture()
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${service.origin}/api/knowledge/status`,
        { headers: { Authorization: [service.headers.Authorization, 'Bearer forged'] } },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode))
        },
      )
      request.once('error', reject)
      request.end()
    })
    expect(status).toBe(401)
    expect(service.transport).not.toHaveBeenCalled()
  } finally {
    await service.close()
  }
})

it.each(['malformed', 'unavailable', 'invalid-signature'])(
  'returns only stable authentication diagnostics: %s',
  async (mode) => {
    const service = await serviceFixture()
    try {
      if (mode === 'unavailable')
        service.transport.mockRejectedValue(new Error('synthetic-private-issuer-diagnostic'))
      const authorization =
        mode === 'malformed'
          ? 'Basic synthetic-private-password'
          : mode === 'invalid-signature'
            ? `Bearer ${await accessToken({ aud: 'wrong-resource' })}`
            : service.headers.Authorization
      const response = await fetch(`${service.origin}/api/knowledge/status`, {
        headers: { Authorization: authorization },
      })
      expect(response.status).toBe(mode === 'unavailable' ? 503 : 401)
      expect(await response.json()).toEqual({
        code: mode === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'UNAUTHENTICATED',
        requestId: null,
      })
      expect(service.pool.query).toHaveBeenCalledOnce()
    } finally {
      await service.close()
    }
  },
)

it('isolates a disconnected client from the shared JWKS lookup', async () => {
  const service = await serviceFixture()
  let release!: (response: Response) => void
  service.transport.mockReturnValue(
    new Promise<Response>((resolve) => {
      release = resolve
    }),
  )
  const controller = new AbortController()
  const cancelled = fetch(`${service.origin}/api/knowledge/status`, {
    headers: service.headers,
    signal: controller.signal,
  }).catch(() => undefined)
  try {
    await vi.waitFor(() => expect(service.transport).toHaveBeenCalledOnce())
    controller.abort()
    const active = fetch(`${service.origin}/api/knowledge/status`, { headers: service.headers })
    release(Response.json(publicKeySet))
    expect((await active).status).toBe(200)
    expect(service.transport).toHaveBeenCalledOnce()
  } finally {
    release(Response.json(publicKeySet))
    await cancelled
    await service.close()
  }
})
