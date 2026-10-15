import { Worker } from 'node:worker_threads'
import { KnowledgeTextError, rejectText } from './errors'
import { textRequest } from './request'
import type { KnowledgeTextDocument } from './text-document'
import type { KnowledgeMarkdownDocument } from './markdown-document'
import type { KnowledgeWorkerResult } from './worker-message'

export interface KnowledgeTextWorkerOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

let activeWorkers = 0

async function parseInWorker<T>(
  entry: string,
  value: unknown,
  policy: unknown,
  options: KnowledgeTextWorkerOptions,
): Promise<T> {
  const { input, limits } = textRequest(value, policy)
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
    rejectText('INVALID_REQUEST')
  if (options.signal?.aborted) rejectText('CANCELLED')
  const deadline = performance.now() + timeout
  // ponytail: two active parsers per process; B4 can schedule work rather than grow an unbounded wait queue.
  if (activeWorkers >= 2) rejectText('BUSY')
  activeWorkers += 1
  try {
    const bytes = Uint8Array.from(input.bytes)
    return await new Promise<T>((resolve, reject) => {
      let worker: Worker
      let settled = false
      const onAbort = () => finish({ ok: false, reason: 'CANCELLED' })
      const finish = (result: KnowledgeWorkerResult<T>) => {
        if (settled) return
        // Timers may be dispatched late; a queued result must still pass the monotonic deadline.
        const outcome: KnowledgeWorkerResult<T> =
          result.ok && performance.now() >= deadline ? { ok: false, reason: 'TIMED_OUT' } : result
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        // Release the concurrency slot only after the worker is actually terminated, including cancelled work.
        void worker.terminate().then(
          () => {
            if (outcome.ok) resolve(outcome.document)
            else reject(new KnowledgeTextError(outcome.reason))
          },
          () => reject(new KnowledgeTextError('WORKER_FAILED')),
        )
      }
      try {
        worker = new Worker(new URL(entry, import.meta.url), {
          workerData: { input: { bytes, sourceHash: input.sourceHash }, limits },
          transferList: [bytes.buffer],
          execArgv: [],
          env: {},
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
          stdout: true,
          stderr: true,
        })
      } catch {
        reject(new KnowledgeTextError('WORKER_FAILED'))
        return
      }
      worker.stdout?.resume()
      worker.stderr?.resume()
      worker.once('message', (result: KnowledgeWorkerResult<T>) => finish(result))
      worker.once('error', () => finish({ ok: false, reason: 'WORKER_FAILED' }))
      worker.once('exit', () => {
        if (!settled) finish({ ok: false, reason: 'WORKER_FAILED' })
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // Events fire only after the executor returns, so `finish` never reads this before initialization.
      const timer = setTimeout(
        () => finish({ ok: false, reason: 'TIMED_OUT' }),
        Math.max(1, deadline - performance.now()),
      )
      if (options.signal?.aborted) onAbort()
    })
  } finally {
    activeWorkers -= 1
  }
}

export function parseKnowledgeTextInWorker(
  value: unknown,
  policy: unknown,
  options: KnowledgeTextWorkerOptions = {},
) {
  return parseInWorker<KnowledgeTextDocument>('./text-worker.mjs', value, policy, options)
}

export function parseKnowledgeMarkdownInWorker(
  value: unknown,
  policy: unknown,
  options: KnowledgeTextWorkerOptions = {},
) {
  return parseInWorker<KnowledgeMarkdownDocument>('./markdown-worker.mjs', value, policy, options)
}
