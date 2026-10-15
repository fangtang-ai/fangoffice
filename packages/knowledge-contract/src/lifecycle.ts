import { matchDocumentParent } from './core'
import { knowledgeError } from './errors'
import {
  parseKnowledgeBuildTarget,
  parseKnowledgeDocumentTarget,
  parseKnowledgeOperationTarget,
  parseKnowledgeVersionTarget,
  type KnowledgeDocumentTarget,
  type KnowledgeBuildTarget,
  type KnowledgeOperationTarget,
  type KnowledgeVersionTarget,
} from './requests'
import {
  choice,
  counter,
  integer,
  invalid,
  nullable,
  object,
  sha256,
  text,
  uuid,
} from './validation'

const build = object({
  id: uuid,
  spaceId: uuid,
  documentId: uuid,
  versionId: uuid,
  operationId: uuid,
  indexProfileId: uuid,
  parserRevision: text(128),
  expectedGeneration: counter,
  jobId: uuid,
  retryCount: integer(0, 2147483647),
  status: choice(['building', 'sealed', 'invalidated', 'purged']),
  manifestHash: nullable(sha256),
})
const operation = object({
  id: uuid,
  spaceId: uuid,
  documentId: uuid,
  kind: choice(['upload', 'replace', 'rebuild', 'delete']),
  phase: choice([
    'uploading',
    'queued',
    'parsing',
    'indexing',
    'publishing',
    'ready',
    'failed',
    'cancelled',
    'deleting',
    'deleted',
  ]),
  expectedGeneration: counter,
  targetVersionId: nullable(uuid),
  error: nullable(knowledgeError),
})

export function parseKnowledgeBuild(
  input: unknown,
  parent: KnowledgeVersionTarget | KnowledgeBuildTarget,
) {
  const result = build(input, 'build')
  const expected =
    'buildId' in parent ? parseKnowledgeBuildTarget(parent) : parseKnowledgeVersionTarget(parent)
  matchDocumentParent(result, expected, 'build')
  if (result.versionId !== expected.versionId) invalid('build.versionId')
  if ('buildId' in expected && result.id !== expected.buildId) invalid('build.id')
  if (result.status === 'sealed' && result.manifestHash === null) invalid('build.manifestHash')
  if (result.status === 'building' && result.manifestHash !== null) invalid('build.manifestHash')
  return result
}

// Ingestion and deletion have distinct prerequisites; only failed carries an error.
export function parseKnowledgeOperation(
  input: unknown,
  parent: KnowledgeDocumentTarget | KnowledgeOperationTarget,
) {
  const result = operation(input, 'operation')
  const expected =
    'operationId' in parent
      ? parseKnowledgeOperationTarget(parent)
      : parseKnowledgeDocumentTarget(parent)
  matchDocumentParent(result, expected, 'operation')
  if ('operationId' in expected && result.id !== expected.operationId) invalid('operation.id')
  const ingestionPhases: readonly string[] = [
    'queued',
    'parsing',
    'indexing',
    'publishing',
    'ready',
  ]
  if (ingestionPhases.includes(result.phase) && result.targetVersionId === null) {
    invalid('operation.targetVersionId')
  }
  if (result.kind === 'delete') {
    if (!['deleting', 'deleted', 'failed', 'cancelled'].includes(result.phase)) {
      invalid('operation.phase')
    }
  } else if (result.phase === 'deleting' || result.phase === 'deleted') {
    invalid('operation.phase')
  }
  if (result.kind === 'rebuild' && result.phase === 'uploading') invalid('operation.phase')
  if ((result.phase === 'failed') !== (result.error !== null)) invalid('operation.error')
  return result
}

export type KnowledgeBuild = ReturnType<typeof parseKnowledgeBuild>
export type KnowledgeOperation = ReturnType<typeof parseKnowledgeOperation>
