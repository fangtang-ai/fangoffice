import { expect, it, vi } from 'vitest'
import { startKnowledgeApi } from '../src/runtime'
import { localApiConfig, syntheticPool } from './runtime-service-fixtures'
import { accessToken, publicKeySet } from './runtime-auth-fixtures'
import { now } from './fixtures'

it('listens only after the dedicated probe and exposes no fabricated business data', async () => {
  const pool = syntheticPool()
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(publicKeySet))
  const service = await startKnowledgeApi(localApiConfig(), {
    poolFactory: () => pool,
    authentication: { fetch: transport, now: () => now },
  })
  try {
    expect(pool.query).toHaveBeenCalledOnce()
    const health = await fetch(`${service.origin}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    const unauthorized = await fetch(`${service.origin}/api/knowledge/status`)
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ code: 'UNAUTHENTICATED', requestId: null })
    const headers = { Authorization: `Bearer ${await accessToken()}` }
    const response = await fetch(`${service.origin}/api/knowledge/status`, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect((await fetch(`${service.origin}/api/knowledge/spaces`, { headers })).status).toBe(404)
    expect(transport).toHaveBeenCalledOnce()
  } finally {
    await service.close()
  }
  expect(await service.finished).toEqual({ code: 'STOPPED' })
  expect(pool.end).toHaveBeenCalledOnce()
})

it('does not allocate a connection after startup was cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const poolFactory = vi.fn(() => syntheticPool())
  await expect(
    startKnowledgeApi(localApiConfig(), { signal: controller.signal, poolFactory }),
  ).rejects.toThrow('CANCELLED')
  expect(poolFactory).not.toHaveBeenCalled()
})

it('closes its pool and sanitizes a failed startup probe', async () => {
  const pool = syntheticPool()
  pool.query.mockRejectedValue(new Error('synthetic-private-password'))
  await expect(startKnowledgeApi(localApiConfig(), { poolFactory: () => pool })).rejects.toThrow(
    'SERVICE_UNAVAILABLE',
  )
  expect(pool.end).toHaveBeenCalledOnce()
})

it('does not hide failed startup cleanup behind a caller cancellation', async () => {
  const pool = syntheticPool()
  const identity = await pool.query('synthetic fixture only')
  pool.query.mockClear()
  let release!: (result: typeof identity) => void
  pool.query.mockReturnValue(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  pool.end.mockRejectedValue(new Error('synthetic-private-cleanup-error'))
  const controller = new AbortController()
  const startup = startKnowledgeApi(localApiConfig(), {
    poolFactory: () => pool,
    signal: controller.signal,
  })
  controller.abort()
  release(identity)
  await expect(startup).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(pool.end).toHaveBeenCalledOnce()
})

it('honors caller cancellation and closes idempotently', async () => {
  const controller = new AbortController()
  const pool = syntheticPool()
  const service = await startKnowledgeApi(localApiConfig(), {
    signal: controller.signal,
    poolFactory: () => pool,
  })
  controller.abort()
  expect(await service.finished).toEqual({ code: 'STOPPED' })
  await Promise.all([service.close(), service.close()])
  expect(pool.end).toHaveBeenCalledOnce()
})

it('stops on an idle driver failure without disclosing the driver error', async () => {
  const pool = syntheticPool()
  const service = await startKnowledgeApi(localApiConfig(), { poolFactory: () => pool })
  pool.on.mock.calls[0]![1]()
  expect(await service.finished).toEqual({ code: 'SERVICE_UNAVAILABLE' })
  expect(pool.end).toHaveBeenCalledOnce()
})

it('bounds shutdown even if a driver refuses to drain', async () => {
  const pool = syntheticPool()
  pool.end.mockImplementation(() => new Promise<void>(() => {}))
  const service = await startKnowledgeApi(localApiConfig(), {
    poolFactory: () => pool,
    shutdownTimeoutMs: 10,
  })
  await expect(service.close()).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(await service.finished).toEqual({ code: 'SERVICE_UNAVAILABLE' })
})

it.each([0, -1, NaN, Infinity, 30001])(
  'rejects invalid shutdown timeout before opening a pool: %s',
  async (shutdownTimeoutMs) => {
    const poolFactory = vi.fn(() => syntheticPool())
    await expect(
      startKnowledgeApi(localApiConfig(), { poolFactory, shutdownTimeoutMs }),
    ).rejects.toThrow('NOT_CONFIGURED')
    expect(poolFactory).not.toHaveBeenCalled()
  },
)
