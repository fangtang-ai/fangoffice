import { expect, it, vi } from 'vitest'
import { parseKnowledgeRuntimeConfig, startKnowledgeWorker } from '../src/runtime'
import { environment } from './runtime-fixtures'
import { syntheticPool } from './runtime-service-fixtures'

it('starts an independent worker with its dedicated role and no HTTP listener or auth configuration', async () => {
  const pool = syntheticPool('knowledge_worker')
  const config = parseKnowledgeRuntimeConfig(
    { ...environment, KNOWLEDGE_AUTH_ISSUER: '', KNOWLEDGE_AUTH_AUDIENCE: '' },
    'worker',
  )
  if (config.role !== 'worker') throw new Error('expected worker config')
  const worker = await startKnowledgeWorker(config, { poolFactory: () => pool })
  try {
    expect(pool.query).toHaveBeenCalledOnce()
    expect(worker).not.toHaveProperty('origin')
  } finally {
    await Promise.all([worker.close(), worker.close()])
  }
  expect(pool.end).toHaveBeenCalledOnce()
  expect(await worker.finished).toEqual({ code: 'STOPPED' })
})

it('keeps bounded sequential health probes and stops after database failure', async () => {
  vi.useFakeTimers()
  const pool = syntheticPool('knowledge_worker')
  const config = parseKnowledgeRuntimeConfig(environment, 'worker')
  if (config.role !== 'worker') throw new Error('expected worker config')
  const worker = await startKnowledgeWorker(config, { poolFactory: () => pool })
  try {
    await vi.advanceTimersByTimeAsync(15000)
    expect(pool.query).toHaveBeenCalledTimes(2)
    pool.query.mockRejectedValue(new Error('synthetic-private-driver-error'))
    await vi.advanceTimersByTimeAsync(15000)
    expect(await worker.finished).toEqual({ code: 'SERVICE_UNAVAILABLE' })
    expect(pool.end).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await worker.close()
    vi.useRealTimers()
  }
})
