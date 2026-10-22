import { resolveKnowledgeEndpoint } from './endpoint'
import { KnowledgeClientError } from './errors'
import { createRequestLifetime } from './lifetime'
import { cancelResponse, parseResponse } from './response'
import { bindAccount, readToken } from './session'
import type { KnowledgeAccountAccess, KnowledgeRequestOptions } from './types'

export function createKnowledgeTransport(
  access: KnowledgeAccountAccess,
  closed: AbortSignal,
  timeoutMs: number,
) {
  const endpoint = () =>
    resolveKnowledgeEndpoint({
      apiBase: access.apiBase(),
      knowledgeBase: access.knowledgeBase(),
      allowLoopback: access.allowLoopback,
    })
  return async <Value>(
    path: string,
    parse: (input: unknown) => Value,
    options: KnowledgeRequestOptions = {},
    mutation?: { method: 'PUT' | 'POST'; body: object },
  ) => {
    if (closed.aborted) throw new KnowledgeClientError('knowledge:closed')
    const root = endpoint()
    const url = new URL(`${root.href}${path}`)
    const binding = bindAccount(access)
    const lifetime = createRequestLifetime(access, binding, closed, options.signal, timeoutMs)
    // 认证重试只重发同一快照，不因调用方修改输入而改变幂等请求。
    const body = mutation ? JSON.stringify(mutation.body) : undefined
    const check = () => {
      lifetime.check()
      if (endpoint().href !== root.href)
        throw new KnowledgeClientError('knowledge:untrusted-target')
    }
    return lifetime.run(async () => {
      try {
        for (let attempt = 0, rejected = ''; attempt < 2; attempt += 1) {
          check()
          const token = await readToken(access, binding, rejected || undefined)
          check()
          const response = await globalThis.fetch(url, {
            method: mutation?.method ?? 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              ...(mutation ? { 'Content-Type': 'application/json' } : {}),
            },
            body,
            signal: lifetime.signal,
            credentials: 'omit',
            redirect: 'error',
          })
          try {
            check()
          } catch (error) {
            cancelResponse(response)
            throw error
          }
          if (
            response.redirected ||
            (response.status >= 300 && response.status < 400) ||
            (response.url && response.url !== url.href)
          ) {
            cancelResponse(response)
            throw new KnowledgeClientError('knowledge:untrusted-target')
          }
          if (response.status === 401) {
            cancelResponse(response)
            if (attempt === 1) throw new KnowledgeClientError('knowledge:account-required')
            rejected = token
            continue
          }
          const onAbort = () => cancelResponse(response)
          lifetime.signal.addEventListener('abort', onAbort, { once: true })
          try {
            const result = await parseResponse(response, parse)
            check()
            return result
          } finally {
            lifetime.signal.removeEventListener('abort', onAbort)
          }
        }
        throw new KnowledgeClientError('knowledge:account-required')
      } catch (error) {
        check()
        if (error instanceof KnowledgeClientError) throw error
        throw new KnowledgeClientError('knowledge:request-failed')
      }
    })
  }
}
