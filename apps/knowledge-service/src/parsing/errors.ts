import type { KnowledgeErrorCode } from '@genoffice/knowledge-contract'

const codes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  SOURCE_MISMATCH: 'INVALID_REQUEST',
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  INVALID_UTF8: 'INCOMPLETE_CONTENT',
  BINARY_CONTENT: 'INCOMPLETE_CONTENT',
  CORRUPT_CONTAINER: 'INCOMPLETE_CONTENT',
  ENCRYPTED_FILE: 'ENCRYPTED_FILE',
  LIMIT_EXCEEDED: 'INCOMPLETE_CONTENT',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'SERVICE_UNAVAILABLE',
  WORKER_FAILED: 'SERVICE_UNAVAILABLE',
  BUSY: 'SERVICE_UNAVAILABLE',
} as const satisfies Record<string, KnowledgeErrorCode>

export type KnowledgeTextFailure = keyof typeof codes

export class KnowledgeTextError extends Error {
  readonly code: KnowledgeErrorCode
  constructor(readonly reason: KnowledgeTextFailure) {
    super(reason)
    this.name = 'KnowledgeTextError'
    this.code = codes[reason]
  }
}

export function rejectText(reason: KnowledgeTextFailure): never {
  throw new KnowledgeTextError(reason)
}
