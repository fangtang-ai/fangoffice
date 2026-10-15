import {
  parseKnowledgeBuild,
  parseKnowledgeBuildTarget,
  parseKnowledgeDocument,
  parseKnowledgeDocumentTarget,
  parseKnowledgeOperation,
  parseKnowledgeOperationTarget,
  parseKnowledgeScope,
  parseKnowledgeSpace,
  parseKnowledgeVersion,
  parseKnowledgeVersionTarget,
} from '@genoffice/knowledge-contract'
import { deny } from './errors'
import { requireKnowledgePrincipal, type KnowledgePrincipal } from './identity'

export interface KnowledgeOwnedResource {
  ownerId: string
  value: unknown
}

export interface KnowledgeResourceFacts {
  space: KnowledgeOwnedResource | null
  document: KnowledgeOwnedResource | null
  version?: KnowledgeOwnedResource | null
  build?: KnowledgeOwnedResource | null
  operation?: KnowledgeOwnedResource | null
}

function readOwned<Value>(
  resource: KnowledgeOwnedResource | null | undefined,
  ownerId: string,
  parse: (input: unknown) => Value,
) {
  if (!resource || resource.ownerId !== ownerId) deny('NOT_FOUND')
  try {
    return parse(resource.value)
  } catch {
    deny('NOT_FOUND')
  }
}

function parseTarget(
  input: unknown,
): ReturnType<
  | typeof parseKnowledgeBuildTarget
  | typeof parseKnowledgeVersionTarget
  | typeof parseKnowledgeOperationTarget
  | typeof parseKnowledgeDocumentTarget
> {
  if (input && typeof input === 'object') {
    if ('buildId' in input) return parseKnowledgeBuildTarget(input)
    if ('versionId' in input) return parseKnowledgeVersionTarget(input)
    if ('operationId' in input) return parseKnowledgeOperationTarget(input)
  }
  return parseKnowledgeDocumentTarget(input)
}

export function authorizeKnowledgeTarget(
  principal: KnowledgePrincipal,
  input: unknown,
  facts: KnowledgeResourceFacts,
  scopeInput: unknown,
  mode: 'active' | 'history' | 'maintenance',
  now: number,
) {
  const { ownerId } = requireKnowledgePrincipal(principal, now)
  const target = parseTarget(input)
  const scope = parseKnowledgeScope(scopeInput)
  if (!['active', 'history', 'maintenance'].includes(mode)) deny('INVALID_REQUEST')
  const withinScope =
    scope.kind === 'spaces'
      ? scope.spaceIds.includes(target.spaceId)
      : scope.documents.some(
          (selected) =>
            selected.spaceId === target.spaceId && selected.documentId === target.documentId,
        )
  if (!withinScope) deny('FORBIDDEN')
  const space = readOwned(facts.space, ownerId, parseKnowledgeSpace)
  const parent = { spaceId: target.spaceId, documentId: target.documentId }
  const document = readOwned(facts.document, ownerId, (value) =>
    parseKnowledgeDocument(value, parent),
  )
  if (space.id !== target.spaceId) deny('NOT_FOUND')
  if (
    mode !== 'maintenance' &&
    (document.deletedAt !== null || space.state === 'deleting' || space.state === 'deleted')
  )
    deny('NOT_FOUND')
  if (mode === 'active' && space.state !== 'active') deny('FORBIDDEN')
  if (mode === 'active' && !document.active) deny('NOT_FOUND')
  if (mode === 'history' && !('versionId' in target)) deny('INVALID_REQUEST')
  if ('versionId' in target) {
    const versionTarget = { ...parent, versionId: target.versionId }
    const version = readOwned(facts.version, ownerId, (value) =>
      parseKnowledgeVersion(value, versionTarget),
    )
    if (mode !== 'maintenance' && version.purgedAt !== null) deny('NOT_FOUND')
    if (mode === 'active' && version.id !== document.active?.versionId) deny('NOT_FOUND')
    if ('buildId' in target) {
      const build = readOwned(facts.build, ownerId, (value) =>
        parseKnowledgeBuild(value, { ...versionTarget, buildId: target.buildId }),
      )
      if (mode !== 'maintenance' && build.status !== 'sealed') deny('NOT_FOUND')
      if (mode === 'active' && build.id !== document.active?.buildId) deny('NOT_FOUND')
    }
  }
  if ('operationId' in target) {
    if (mode !== 'maintenance') deny('INVALID_REQUEST')
    readOwned(facts.operation, ownerId, (value) =>
      parseKnowledgeOperation(value, { ...parent, operationId: target.operationId }),
    )
  }
  // These are trusted-read facts, not a lock or a durable authorization grant; publish must recheck them.
  return { ownerId, target }
}
