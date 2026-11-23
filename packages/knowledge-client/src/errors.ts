import type { KnowledgeError } from '@genoffice/knowledge-contract'

export class KnowledgeClientError extends Error {
  constructor(
    readonly code:
      | 'knowledge:not-configured'
      | 'knowledge:untrusted-target'
      | 'knowledge:account-required'
      | 'knowledge:account-changed'
      | 'knowledge:cancelled'
      | 'knowledge:request-failed'
      | 'knowledge:request-timeout'
      | 'knowledge:invalid-response'
      | 'knowledge:closed',
    readonly problem?: KnowledgeError,
  ) {
    super(code)
    this.name = 'KnowledgeClientError'
  }
}
