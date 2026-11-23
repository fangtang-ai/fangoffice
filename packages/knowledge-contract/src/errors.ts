import { choice, nullable, object, uuid } from './validation.js'

export const knowledgeError = object({
  code: choice([
    'INVALID_REQUEST',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'QUOTA_EXCEEDED',
    'VERSION_CONFLICT',
    'UNSUPPORTED_FORMAT',
    'OCR_REQUIRED',
    'ENCRYPTED_FILE',
    'EMPTY_CONTENT',
    'INCOMPLETE_CONTENT',
    'SERVICE_UNAVAILABLE',
    'NOT_CONFIGURED',
    'CANCELLED',
  ]),
  requestId: nullable(uuid),
})

export function parseKnowledgeError(input: unknown) {
  return knowledgeError(input, 'error')
}

export type KnowledgeError = ReturnType<typeof parseKnowledgeError>
export type KnowledgeErrorCode = KnowledgeError['code']
