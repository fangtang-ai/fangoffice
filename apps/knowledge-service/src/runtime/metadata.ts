import {
  parseKnowledgeSpace,
  parseKnowledgeSpaceInput,
  parseKnowledgeSpaceTarget,
  parseKnowledgeDocument,
  parseKnowledgeDocumentInput,
  parseKnowledgeDocumentTarget,
  type KnowledgeDocumentTarget,
} from '@genoffice/knowledge-contract'
import { uploadCommand, uploadFact, uploadInput } from './upload-command'
import type { KnowledgeTransaction } from './transaction'

export async function createKnowledgeSpace(
  transaction: KnowledgeTransaction,
  resourceId: string,
  input: unknown,
) {
  const target = uploadInput(parseKnowledgeSpaceTarget, { spaceId: resourceId })
  const metadata = uploadInput(parseKnowledgeSpaceInput, input)
  const replayed = await uploadCommand(
    transaction,
    'SELECT knowledge.create_space($1,$2) AS status',
    [target.spaceId, metadata.title],
  )
  const { rows } = await transaction.query(
    "SELECT jsonb_build_object('id',id,'title',title,'state',state) AS value FROM knowledge.kb_spaces WHERE id = $1",
    [target.spaceId],
  )
  return {
    replayed,
    space: uploadFact(parseKnowledgeSpace, (rows[0] as { value?: unknown } | undefined)?.value),
  }
}

export async function createKnowledgeDocument(
  transaction: KnowledgeTransaction,
  parent: KnowledgeDocumentTarget,
  input: unknown,
) {
  const target = uploadInput(parseKnowledgeDocumentTarget, parent)
  const metadata = uploadInput(parseKnowledgeDocumentInput, input)
  const replayed = await uploadCommand(
    transaction,
    'SELECT knowledge.create_document($1,$2,$3,$4,$5) AS status',
    [target.documentId, target.spaceId, metadata.title, metadata.tags, metadata.purpose],
  )
  const { rows } = await transaction.query(
    `SELECT jsonb_build_object('id',id,'spaceId',space_id,'title',title,'tags',tags,'purpose',purpose,
       'generation',generation::text,'active',CASE WHEN active_build_id IS NULL THEN NULL ELSE
         jsonb_build_object('versionId',active_version_id,'buildId',active_build_id,'treeBuildId',NULL) END,
       'desired',CASE WHEN desired_operation_id IS NULL THEN NULL ELSE
         jsonb_build_object('operationId',desired_operation_id,'versionId',desired_version_id) END,
       'deletedAt',NULL) AS value FROM knowledge.kb_documents WHERE id = $1 AND space_id = $2`,
    [target.documentId, target.spaceId],
  )
  const document = uploadFact(
    (value) => parseKnowledgeDocument(value, target),
    (rows[0] as { value?: unknown } | undefined)?.value,
  )
  return { replayed, document }
}
