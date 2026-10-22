import {
  parseKnowledgeDocument,
  parseKnowledgePage,
  parseKnowledgeSpace,
  type KnowledgeDocumentTarget,
  type KnowledgePagination,
} from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'
import { uploadFact } from './upload-command'

const documentProjection = `jsonb_build_object(
  'id',d.id,'spaceId',d.space_id,'title',d.title,'tags',d.tags,'purpose',d.purpose,
  'generation',d.generation::text,'active',CASE WHEN d.active_build_id IS NULL THEN NULL ELSE
    jsonb_build_object('versionId',d.active_version_id,'buildId',d.active_build_id,'treeBuildId',NULL) END,
  'desired',CASE WHEN d.desired_operation_id IS NULL THEN NULL ELSE
    jsonb_build_object('operationId',d.desired_operation_id,'versionId',d.desired_version_id) END,
  'deletedAt',NULL)`

const readableDocuments = `FROM knowledge.kb_documents d
  JOIN knowledge.kb_spaces s ON s.owner_id=d.owner_id AND s.id=d.space_id
  WHERE d.deleted_at IS NULL AND s.deleted_at IS NULL AND s.state IN ('active','frozen')`

function rowValue(row: unknown) {
  if (typeof row !== 'object' || row === null || !('value' in row)) deny('SERVICE_UNAVAILABLE')
  return row.value
}

function metadataPage<Item extends { id: string }>(
  rows: unknown[],
  parseItem: (value: unknown) => Item,
  pagination: KnowledgePagination,
) {
  const items = rows.slice(0, pagination.limit).map((row) => uploadFact(parseItem, rowValue(row)))
  return uploadFact((value) => parseKnowledgePage(value, parseItem, pagination), {
    items,
    nextCursor: rows.length > pagination.limit ? (items.at(-1)?.id ?? null) : null,
  })
}

export async function readKnowledgeSpaces(
  transaction: KnowledgeTransaction,
  pagination: KnowledgePagination,
) {
  const { rows } = await transaction.query(
    `SELECT jsonb_build_object('id',id,'title',title,'state',state) AS value
       FROM knowledge.kb_spaces WHERE deleted_at IS NULL AND state IN ('active','frozen')
        AND ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`,
    [pagination.cursor, pagination.limit + 1],
  )
  return metadataPage(rows, parseKnowledgeSpace, pagination)
}

export async function readKnowledgeDocuments(
  transaction: KnowledgeTransaction,
  spaceId: string,
  pagination: KnowledgePagination,
) {
  const parent = await transaction.query(
    `SELECT id FROM knowledge.kb_spaces
      WHERE id=$1 AND deleted_at IS NULL AND state IN ('active','frozen')`,
    [spaceId],
  )
  if (parent.rows.length !== 1) deny('NOT_FOUND')
  // Both queries use the caller's owner-scoped transaction; recheck the parent in the listing snapshot.
  const { rows } = await transaction.query(
    `SELECT ${documentProjection} AS value ${readableDocuments}
      AND d.space_id=$1 AND ($2::uuid IS NULL OR d.id > $2::uuid) ORDER BY d.id LIMIT $3`,
    [spaceId, pagination.cursor, pagination.limit + 1],
  )
  return metadataPage(rows, (value) => parseKnowledgeDocument(value, { spaceId }), pagination)
}

export async function readKnowledgeDocument(
  transaction: KnowledgeTransaction,
  target: KnowledgeDocumentTarget,
) {
  const { rows } = await transaction.query(
    `SELECT ${documentProjection} AS value ${readableDocuments}
      AND d.space_id=$1 AND d.id=$2`,
    [target.spaceId, target.documentId],
  )
  if (rows.length !== 1) deny('NOT_FOUND')
  return uploadFact((value) => parseKnowledgeDocument(value, target), rowValue(rows[0]))
}
