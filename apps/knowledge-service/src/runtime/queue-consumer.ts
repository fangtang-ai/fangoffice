import { setTimeout as delay } from 'node:timers/promises'
import { deny, KnowledgePolicyError } from '../errors'
import { withinShutdown } from './lifecycle'
import { parseQueueEnvelope, type QueueEnvelope, type QueueJobRef } from './queue-envelope'
import type { KnowledgeQueue, KnowledgeQueueJob } from './queue'

export type KnowledgeQueueHandler = (context: {
  job: QueueJobRef
  envelope: QueueEnvelope
  signal: AbortSignal
}) => Promise<void>

export interface KnowledgeQueueConsumerOptions {
  signal?: AbortSignal
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  shutdownTimeoutMs?: number
}

async function consumeAttempt(
  queue: KnowledgeQueue,
  job: KnowledgeQueueJob,
  handle: KnowledgeQueueHandler,
  signal: AbortSignal,
  heartbeatIntervalMs: number,
) {
  if (signal.aborted) return
  await queue.heartbeat(job)
  const lease = new AbortController()
  const attemptSignal = AbortSignal.any([signal, lease.signal])
  const interval = Math.max(
    1,
    Math.min(
      heartbeatIntervalMs,
      job.heartbeatSeconds === null ? heartbeatIntervalMs : job.heartbeatSeconds * 500,
      job.expireInSeconds * 500,
    ),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = Promise.resolve()
  let stopped = false
  let failure: KnowledgePolicyError['code'] | undefined
  // 心跳串行且不与最终结算重叠；失去attempt后立即撤销handler，绝不旧任务结算。
  const stopHeartbeat = () => {
    stopped = true
    clearTimeout(timer)
  }
  const schedule = () => {
    if (stopped || attemptSignal.aborted) return
    timer = setTimeout(() => {
      pending = queue.heartbeat(job).then(
        () => {
          if (!stopped) schedule()
        },
        () => lease.abort(),
      )
    }, interval)
  }
  attemptSignal.addEventListener('abort', stopHeartbeat, { once: true })
  schedule()
  try {
    const envelope = parseQueueEnvelope(job.data)
    if (!attemptSignal.aborted)
      await handle({
        job: { id: job.id, retryCount: job.retryCount },
        envelope,
        signal: attemptSignal,
      })
  } catch (error) {
    failure = error instanceof KnowledgePolicyError ? error.code : 'SERVICE_UNAVAILABLE'
  } finally {
    stopHeartbeat()
    attemptSignal.removeEventListener('abort', stopHeartbeat)
    await pending
  }
  if (attemptSignal.aborted) return
  await queue.heartbeat(job)
  if (attemptSignal.aborted) return
  // 仅保存稳定错误码，不把异常正文、文档内容或供应商凭据写进队列output。
  if (failure) await queue.fail(job, failure)
  else await queue.complete(job)
}

export function startKnowledgeQueueConsumer(
  queue: KnowledgeQueue,
  handle: KnowledgeQueueHandler,
  options: KnowledgeQueueConsumerOptions = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1000
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000
  for (const [value, maximum] of [
    [pollIntervalMs, 60000],
    [heartbeatIntervalMs, 60000],
    [shutdownTimeoutMs, 30000],
  ]) {
    if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!) deny('NOT_CONFIGURED')
  }
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([stop.signal, options.signal]) : stop.signal
  const finished = (async () => {
    while (!signal.aborted) {
      const job = await queue.fetch()
      if (job) {
        try {
          await consumeAttempt(queue, job, handle, signal, heartbeatIntervalMs)
        } catch (error) {
          if (!(error instanceof KnowledgePolicyError && error.code === 'VERSION_CONFLICT'))
            throw error
        }
      } else {
        try {
          await delay(pollIntervalMs, undefined, { signal })
        } catch (error) {
          if (!signal.aborted) throw error
        }
      }
    }
  })().then(
    () => ({ code: 'STOPPED' as const }),
    () => ({ code: signal.aborted ? ('STOPPED' as const) : ('SERVICE_UNAVAILABLE' as const) }),
  )
  return {
    finished,
    async close() {
      stop.abort()
      await withinShutdown(async () => {
        if ((await finished).code !== 'STOPPED') deny('SERVICE_UNAVAILABLE')
      }, shutdownTimeoutMs)
    },
  }
}
