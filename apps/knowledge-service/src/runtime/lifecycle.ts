import { deny, KnowledgePolicyError } from '../errors'
import { createKnowledgeDatabase, type KnowledgeDatabase } from './database'
import type { KnowledgeRuntimeConfig } from './config'

export interface KnowledgeServiceOptions {
  poolFactory?: Parameters<typeof createKnowledgeDatabase>[1]
  signal?: AbortSignal
  shutdownTimeoutMs?: number
}

type ServiceOutcome = { code: 'STOPPED' | 'SERVICE_UNAVAILABLE' }

export function shutdownTimeout(options: KnowledgeServiceOptions) {
  const timeout = options.shutdownTimeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) deny('NOT_CONFIGURED')
  return timeout
}

export async function withinShutdown(action: () => Promise<unknown>, timeout: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SERVICE_UNAVAILABLE')), timeout)
      }),
    ])
  } catch {
    deny('SERVICE_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
  }
}

export async function openKnowledgeDatabase(
  config: Pick<KnowledgeRuntimeConfig, 'database'>,
  options: KnowledgeServiceOptions,
) {
  const timeout = shutdownTimeout(options)
  if (options.signal?.aborted) deny('CANCELLED')
  const database = createKnowledgeDatabase(config.database, options.poolFactory)
  try {
    await database.verify()
    if (options.signal?.aborted) deny('CANCELLED')
    return database
  } catch (error) {
    try {
      await withinShutdown(() => database.close(), timeout)
    } catch (cleanupError) {
      // Caller cancellation must not hide a failed startup cleanup behind CANCELLED.
      if (error instanceof KnowledgePolicyError && error.code === 'CANCELLED') throw cleanupError
    }
    throw error
  }
}

export function serviceLifetime(
  database: KnowledgeDatabase,
  stop: () => Promise<void>,
  options: KnowledgeServiceOptions,
) {
  const timeout = shutdownTimeout(options)
  let closing: Promise<void> | undefined
  let code: 'STOPPED' | 'SERVICE_UNAVAILABLE' = 'STOPPED'
  let resolve!: (outcome: ServiceOutcome) => void
  const finished = new Promise<ServiceOutcome>((finish) => {
    resolve = finish
  })
  const onStop = () => {
    void close().catch(() => undefined)
  }
  const fail = () => {
    code = 'SERVICE_UNAVAILABLE'
    onStop()
  }
  function close() {
    closing ??= Promise.resolve().then(async () => {
      database.signal.removeEventListener('abort', fail)
      options.signal?.removeEventListener('abort', onStop)
      try {
        // Stop accepting work and drain resources together; neither cleanup may hold shutdown forever.
        await withinShutdown(() => Promise.all([stop(), database.close()]), timeout)
      } catch {
        code = 'SERVICE_UNAVAILABLE'
        deny('SERVICE_UNAVAILABLE')
      } finally {
        resolve({ code })
      }
    })
    return closing
  }
  database.signal.addEventListener('abort', fail, { once: true })
  options.signal?.addEventListener('abort', onStop, { once: true })
  if (database.signal.aborted) fail()
  else if (options.signal?.aborted) onStop()
  return { close, finished, fail }
}
