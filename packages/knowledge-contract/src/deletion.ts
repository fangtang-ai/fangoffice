import { choice, invalid, object, uuid } from './validation.js'

const deletionRequest = object({ intentId: uuid })
const deletion = object({ intentId: uuid, phase: choice(['deleting', 'deleted']) })

export function parseKnowledgeDocumentDeletionRequest(input: unknown) {
  return deletionRequest(input, 'documentDeletionRequest')
}

export function parseKnowledgeDocumentDeletion(
  input: unknown,
  request: KnowledgeDocumentDeletionRequest,
) {
  const expected = parseKnowledgeDocumentDeletionRequest(request)
  const result = deletion(input, 'documentDeletion')
  if (result.intentId !== expected.intentId) invalid('documentDeletion.intentId')
  return result
}

export type KnowledgeDocumentDeletionRequest = ReturnType<
  typeof parseKnowledgeDocumentDeletionRequest
>
export type KnowledgeDocumentDeletion = ReturnType<typeof parseKnowledgeDocumentDeletion>
