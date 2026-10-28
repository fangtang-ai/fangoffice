import {
  documentMetadataFields,
  parseKnowledgeDocumentTarget,
  parseKnowledgeSpaceTarget,
  parseKnowledgeVersionTarget,
  type KnowledgeDocumentTarget,
  type KnowledgeSpaceTarget,
  type KnowledgeVersionTarget,
} from './requests.js'
import {
  choice,
  counter,
  invalid,
  nullable,
  object,
  positiveCounter,
  sha256,
  text,
  timestamp,
  unique,
  uuid,
} from './validation.js'

export const knowledgeSourceFormat = choice(['txt', 'md', 'docx', 'pdf', 'xlsx'])

const space = object({
  id: uuid,
  title: text(200),
  state: choice(['active', 'frozen', 'deleting', 'deleted']),
})
const document = object({
  id: uuid,
  spaceId: uuid,
  ...documentMetadataFields,
  generation: counter,
  active: nullable(object({ versionId: uuid, buildId: uuid, treeBuildId: nullable(uuid) })),
  desired: nullable(object({ operationId: uuid, versionId: nullable(uuid) })),
  deletedAt: nullable(timestamp),
})
const version = object({
  id: uuid,
  spaceId: uuid,
  documentId: uuid,
  operationId: uuid,
  versionNo: positiveCounter,
  format: knowledgeSourceFormat,
  sizeBytes: counter,
  sha256,
  purgedAt: nullable(timestamp),
})

export function parseKnowledgeSpace(input: unknown) {
  return space(input, 'space')
}

export function parseKnowledgeDocument(
  input: unknown,
  parent: KnowledgeSpaceTarget | KnowledgeDocumentTarget,
) {
  const result = document(input, 'document')
  const expected =
    'documentId' in parent
      ? parseKnowledgeDocumentTarget(parent)
      : parseKnowledgeSpaceTarget(parent)
  if (result.spaceId !== expected.spaceId) invalid('document.spaceId')
  if ('documentId' in expected && result.id !== expected.documentId) invalid('document.id')
  unique(result.tags, (tag) => tag, 'document.tags')
  if (result.deletedAt !== null && (result.active !== null || result.desired !== null)) {
    invalid('document.deletedAt')
  }
  return result
}

export function parseKnowledgeVersion(
  input: unknown,
  parent: KnowledgeDocumentTarget | KnowledgeVersionTarget,
) {
  const result = version(input, 'version')
  const expected =
    'versionId' in parent
      ? parseKnowledgeVersionTarget(parent)
      : parseKnowledgeDocumentTarget(parent)
  matchDocumentParent(result, expected, 'version')
  if ('versionId' in expected && result.id !== expected.versionId) invalid('version.id')
  return result
}

export function matchDocumentParent(
  result: KnowledgeDocumentTarget,
  parent: KnowledgeDocumentTarget,
  path: string,
) {
  // This checks protocol consistency only; database ownership must be verified separately.
  if (result.spaceId !== parent.spaceId || result.documentId !== parent.documentId) invalid(path)
}

export type KnowledgeSpace = ReturnType<typeof parseKnowledgeSpace>
export type KnowledgeDocument = ReturnType<typeof parseKnowledgeDocument>
export type KnowledgeVersion = ReturnType<typeof parseKnowledgeVersion>
