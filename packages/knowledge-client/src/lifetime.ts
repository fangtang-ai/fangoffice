import { KnowledgeClientError } from './errors'
import { assertBinding } from './session'
import type { KnowledgeAccountAccess, KnowledgeAccountBinding } from './types'

export function createRequestLifetime(
  access: KnowledgeAccountAccess,
  binding: KnowledgeAccountBinding,
  closed: AbortSignal,
  caller: AbortSignal | undefined,
  timeoutMs: number,
) {
  const deadline = new AbortController()
  const signal = AbortSignal.any([
    binding.signal,
    closed,
    deadline.signal,
    ...(caller ? [caller] : []),
  ])
  const check = () => {
    assertBinding(access, binding)
    if (closed.aborted) throw new KnowledgeClientError('knowledge:closed')
    if (caller?.aborted) throw new KnowledgeClientError('knowledge:cancelled')
    if (deadline.signal.aborted) throw new KnowledgeClientError('knowledge:request-timeout')
  }
  return {
    signal,
    check,
    async run<Value>(work: () => Promise<Value>) {
      check()
      const timer = setTimeout(() => deadline.abort(), timeoutMs)
      let onAbort = () => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          try {
            check()
          } catch (error) {
            reject(error)
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        // The race also bounds token readers and adapters that ignore AbortSignal.
        return await Promise.race([work(), aborted])
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
