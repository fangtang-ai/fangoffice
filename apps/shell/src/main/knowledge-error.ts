import type { KnowledgeFailureCode } from '../shared/knowledge-api'

export class KnowledgeDesktopError extends Error {
  constructor(readonly code: KnowledgeFailureCode) {
    super(code)
  }
}
