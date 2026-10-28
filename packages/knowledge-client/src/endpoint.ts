import { KnowledgeClientError } from './errors.js'

export interface KnowledgeEndpointConfig {
  apiBase: unknown
  knowledgeBase: unknown
  allowLoopback?: boolean
}

export function resolveKnowledgeEndpoint(config: KnowledgeEndpointConfig) {
  if (
    typeof config.apiBase !== 'string' ||
    !config.apiBase ||
    typeof config.knowledgeBase !== 'string' ||
    !config.knowledgeBase
  )
    throw new KnowledgeClientError('knowledge:not-configured')
  try {
    const base = new URL(config.apiBase)
    const loopback =
      config.allowLoopback === true && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
    if (
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
      (config.apiBase !== base.origin && config.apiBase !== `${base.origin}/`)
    )
      throw new Error()
    const expected = new URL('/api/knowledge', base)
    if (config.knowledgeBase !== expected.href && config.knowledgeBase !== `${expected.href}/`)
      throw new Error()
    return expected
  } catch {
    throw new KnowledgeClientError('knowledge:untrusted-target')
  }
}
