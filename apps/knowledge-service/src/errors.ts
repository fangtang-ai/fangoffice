import type { KnowledgeErrorCode } from '@genoffice/knowledge-contract'

export class KnowledgePolicyError extends Error {
  constructor(readonly code: KnowledgeErrorCode) {
    super(code)
    this.name = 'KnowledgePolicyError'
  }
}

export function deny(code: KnowledgeErrorCode): never {
  throw new KnowledgePolicyError(code)
}
