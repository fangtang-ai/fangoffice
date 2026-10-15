import {
  choice,
  counter,
  defaulted,
  integer,
  invalid,
  list,
  nullable,
  object,
  record,
  text,
  unique,
  uuid,
} from './validation'

export const documentTarget = object({ spaceId: uuid, documentId: uuid })
const spaceTarget = object({ spaceId: uuid })
const versionTarget = object({ spaceId: uuid, documentId: uuid, versionId: uuid })
const buildTarget = object({ spaceId: uuid, documentId: uuid, versionId: uuid, buildId: uuid })
const operationTarget = object({ spaceId: uuid, documentId: uuid, operationId: uuid })
const mutationTarget = object({ spaceId: uuid, documentId: uuid, expectedGeneration: counter })
const spaceInput = object({ title: text(200) })
export const documentMetadataFields = {
  title: text(200),
  tags: list(text(50), 0, 20),
  purpose: choice(['facts', 'style', 'template']),
}
const documentInput = object(documentMetadataFields)
const spaceScope = object({ kind: choice(['spaces']), spaceIds: list(uuid, 1, 50) })
const documentScope = object({
  kind: choice(['documents']),
  documents: list(documentTarget, 1, 50),
})
const pageLimit = integer(1, 100)
const pagination = object({
  limit: defaulted((input, path) => {
    const value =
      typeof input === 'string' && /^[1-9][0-9]{0,2}$/.test(input) ? Number(input) : input
    return pageLimit(value, path)
  }, 20),
  cursor: defaulted(nullable(uuid), null),
})

export function parseKnowledgeSpaceInput(input: unknown) {
  return spaceInput(input, 'spaceInput')
}

export function parseKnowledgeDocumentInput(input: unknown) {
  const result = documentInput(input, 'documentInput')
  unique(result.tags, (tag) => tag, 'documentInput.tags')
  return result
}

export function parseKnowledgeDocumentTarget(input: unknown) {
  return documentTarget(input, 'documentTarget')
}

export function parseKnowledgeSpaceTarget(input: unknown) {
  return spaceTarget(input, 'spaceTarget')
}

export function parseKnowledgeVersionTarget(input: unknown) {
  return versionTarget(input, 'versionTarget')
}

export function parseKnowledgeBuildTarget(input: unknown) {
  return buildTarget(input, 'buildTarget')
}

export function parseKnowledgeOperationTarget(input: unknown) {
  return operationTarget(input, 'operationTarget')
}

export function parseKnowledgeMutationTarget(input: unknown) {
  return mutationTarget(input, 'mutationTarget')
}

export function parseKnowledgeScope(input: unknown) {
  const source = record(input, 'scope')
  if (source.kind === 'spaces') {
    const result = spaceScope(input, 'scope')
    unique(result.spaceIds, (id) => id, 'scope.spaceIds')
    return result
  }
  if (source.kind === 'documents') {
    const result = documentScope(input, 'scope')
    // One document cannot be selected twice, even under different claimed parents.
    unique(result.documents, (target) => target.documentId, 'scope.documents')
    return result
  }
  invalid('scope.kind')
}

export function parseKnowledgePagination(input: unknown) {
  return pagination(input, 'pagination')
}

export type KnowledgeSpaceInput = ReturnType<typeof parseKnowledgeSpaceInput>
export type KnowledgeDocumentInput = ReturnType<typeof parseKnowledgeDocumentInput>
export type KnowledgeDocumentTarget = ReturnType<typeof parseKnowledgeDocumentTarget>
export type KnowledgeSpaceTarget = ReturnType<typeof parseKnowledgeSpaceTarget>
export type KnowledgeVersionTarget = ReturnType<typeof parseKnowledgeVersionTarget>
export type KnowledgeBuildTarget = ReturnType<typeof parseKnowledgeBuildTarget>
export type KnowledgeOperationTarget = ReturnType<typeof parseKnowledgeOperationTarget>
export type KnowledgeMutationTarget = ReturnType<typeof parseKnowledgeMutationTarget>
export type KnowledgeScope = ReturnType<typeof parseKnowledgeScope>
export type KnowledgePagination = ReturnType<typeof parseKnowledgePagination>
