import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  KnowledgeContractError,
  parseKnowledgeBuild,
  parseKnowledgeDocument,
  parseKnowledgeError,
  parseKnowledgeOperation,
  parseKnowledgeSpace,
  parseKnowledgeVersion,
} from '../src'

const ids = {
  space: '019a1234-0000-7000-8000-000000000001',
  otherSpace: '019a1234-0000-7000-8000-000000000002',
  document: '019a1234-0000-7000-8000-000000000003',
  version: '019a1234-0000-7000-8000-000000000004',
  build: '019a1234-0000-7000-8000-000000000005',
  operation: '019a1234-0000-7000-8000-000000000006',
  profile: '019a1234-0000-7000-8000-000000000007',
  job: '019a1234-0000-7000-8000-000000000008',
}
const space = { id: ids.space, title: '私人资料', state: 'active' }
const parent = { spaceId: ids.space, documentId: ids.document }
const document = {
  id: ids.document,
  spaceId: ids.space,
  title: '合同',
  tags: ['范本'],
  purpose: 'template',
  generation: '7',
  active: { versionId: ids.version, buildId: ids.build, treeBuildId: null },
  desired: { operationId: ids.operation, versionId: null },
  deletedAt: null,
}
const version = {
  id: ids.version,
  ...parent,
  operationId: ids.operation,
  versionNo: '1',
  format: 'xlsx',
  sizeBytes: '9007199254740993',
  sha256: 'a'.repeat(64),
  purgedAt: null,
}
const build = {
  id: ids.build,
  ...parent,
  versionId: ids.version,
  operationId: ids.operation,
  indexProfileId: ids.profile,
  parserRevision: 'parser-1',
  expectedGeneration: '7',
  jobId: ids.job,
  retryCount: 0,
  status: 'sealed',
  manifestHash: 'b'.repeat(64),
}
const operation = {
  id: ids.operation,
  ...parent,
  kind: 'replace',
  phase: 'indexing',
  expectedGeneration: '7',
  targetVersionId: ids.version,
  error: null,
}

describe('space HTTP/IPC boundary', () => {
  it('represents a frozen space without calling it deleted or available', () => {
    expect(parseKnowledgeSpace({ ...space, state: 'frozen' }).state).toBe('frozen')
  })

  it('accepts only the declared DTO and infers a narrow state', () => {
    expect(parseKnowledgeSpace(space)).toEqual(space)
    expectTypeOf(parseKnowledgeSpace(space).state).toEqualTypeOf<
      'active' | 'frozen' | 'deleting' | 'deleted'
    >()
  })

  it.each([null, [], new Date(), { ...space, id: '../other' }, { ...space, state: 'ready' }])(
    'rejects malformed spaces: %j',
    (value) => expect(() => parseKnowledgeSpace(value)).toThrow(KnowledgeContractError),
  )

  it.each(['owner', 'ownerId', 'owner_id', 'userId', 'token'])('rejects injected %s', (key) => {
    expect(() => parseKnowledgeSpace({ ...space, [key]: 'secret-token' })).toThrow(
      KnowledgeContractError,
    )
    expect(() => parseKnowledgeSpace({ ...space, [key]: 'secret-token' })).not.toThrow(
      /secret-token/,
    )
  })
})

describe('lifecycle metadata responses', () => {
  it('keeps active content visible while replacement has no verified version yet', () => {
    expect(parseKnowledgeDocument(document, { spaceId: ids.space })).toEqual(document)
    expect(
      parseKnowledgeDocument({ ...document, active: null }, { spaceId: ids.space }).active,
    ).toBeNull()
    expectTypeOf(parseKnowledgeDocument(document, { spaceId: ids.space }).generation).toBeString()
  })

  it('parses immutable source/build metadata and operation stage separately', () => {
    expect(parseKnowledgeVersion(version, parent)).toEqual(version)
    expect(parseKnowledgeBuild(build, { ...parent, versionId: ids.version })).toEqual(build)
    expect(parseKnowledgeOperation(operation, parent)).toEqual(operation)
  })

  it('rejects structurally valid objects under a different requested parent', () => {
    const wrongParent = { ...parent, spaceId: ids.otherSpace }
    expect(() => parseKnowledgeDocument(document, { spaceId: ids.otherSpace })).toThrow(
      KnowledgeContractError,
    )
    expect(() => parseKnowledgeVersion(version, wrongParent)).toThrow(KnowledgeContractError)
    expect(() => parseKnowledgeOperation(operation, wrongParent)).toThrow(KnowledgeContractError)
    expect(() => parseKnowledgeBuild(build, { ...parent, versionId: ids.job })).toThrow(
      KnowledgeContractError,
    )
  })

  it('rejects forged owner and raw storage credentials in responses', () => {
    expect(() =>
      parseKnowledgeDocument({ ...document, ownerId: 'other-user' }, { spaceId: ids.space }),
    ).toThrow(KnowledgeContractError)
    expect(() => parseKnowledgeVersion({ ...version, ossKey: 'private-key' }, parent)).toThrow(
      KnowledgeContractError,
    )
    expect(() =>
      parseKnowledgeBuild({ ...build, token: 'secret' }, { ...parent, versionId: ids.version }),
    ).toThrow(KnowledgeContractError)
  })

  it.each([
    { ...document, active: { versionId: ids.version, buildId: null, treeBuildId: null } },
    { ...document, deletedAt: '2026-10-14T00:00:00.000Z' },
    { ...document, deletedAt: '2026-02-30T00:00:00.000Z', active: null, desired: null },
    { ...document, status: 'ready' },
  ])('rejects contradictory document pointers/lifecycle: %j', (value) => {
    expect(() => parseKnowledgeDocument(value, { spaceId: ids.space })).toThrow(
      KnowledgeContractError,
    )
  })

  it.each([
    { ...version, versionNo: '0' },
    { ...version, format: 'xls' },
    { ...version, sha256: 'a'.repeat(63) },
    { ...version, sizeBytes: Number('9007199254740993') },
    { ...version, sizeBytes: '-1' },
  ])('rejects invalid source metadata: %j', (value) => {
    expect(() => parseKnowledgeVersion(value, parent)).toThrow(KnowledgeContractError)
  })

  it.each([
    { ...build, status: 'ready' },
    { ...build, status: 'sealed', manifestHash: null },
    { ...build, status: 'building' },
    { ...build, retryCount: -1 },
    { ...build, retryCount: 0.5 },
  ])('rejects invalid build status or attempt: %j', (value) => {
    expect(() => parseKnowledgeBuild(value, { ...parent, versionId: ids.version })).toThrow(
      KnowledgeContractError,
    )
  })

  it.each(['queued', 'parsing', 'indexing', 'publishing', 'ready'])(
    'requires a verified target version before %s',
    (phase) => {
      expect(() =>
        parseKnowledgeOperation({ ...operation, phase, targetVersionId: null }, parent),
      ).toThrow(KnowledgeContractError)
    },
  )

  it('accepts early upload/cancellation/deletion without inventing a version', () => {
    expect(
      parseKnowledgeOperation(
        { ...operation, kind: 'upload', phase: 'uploading', targetVersionId: null },
        parent,
      ).phase,
    ).toBe('uploading')
    expect(
      parseKnowledgeOperation({ ...operation, phase: 'cancelled', targetVersionId: null }, parent)
        .phase,
    ).toBe('cancelled')
    expect(
      parseKnowledgeOperation(
        { ...operation, kind: 'delete', phase: 'deleted', targetVersionId: null },
        parent,
      ).phase,
    ).toBe('deleted')
  })

  it.each([
    { ...operation, kind: 'delete', phase: 'ready' },
    { ...operation, phase: 'deleted' },
    { ...operation, kind: 'rebuild', phase: 'uploading', targetVersionId: null },
    { ...operation, phase: 'failed', error: null },
    { ...operation, error: { code: 'OCR_REQUIRED', requestId: null } },
    { ...operation, phase: 'success' },
  ])('rejects conflicting operation kind/phase/error: %j', (value) => {
    expect(() => parseKnowledgeOperation(value, parent)).toThrow(KnowledgeContractError)
  })
})

describe('requested target identity', () => {
  it('accepts full matching read targets without dropping their identity', () => {
    expect(parseKnowledgeVersion(version, { ...parent, versionId: ids.version })).toEqual(version)
    expect(
      parseKnowledgeBuild(build, { ...parent, versionId: ids.version, buildId: ids.build }),
    ).toEqual(build)
    expect(parseKnowledgeOperation(operation, { ...parent, operationId: ids.operation })).toEqual(
      operation,
    )
  })

  it('rejects a different document under the correct space', () => {
    expect(() => parseKnowledgeDocument(document, { ...parent, documentId: ids.job })).toThrow(
      KnowledgeContractError,
    )
  })

  it('rejects a different historical version under the same document', () => {
    expect(() => parseKnowledgeVersion(version, { ...parent, versionId: ids.job })).toThrow(
      KnowledgeContractError,
    )
  })

  it('rejects a different build under the same version', () => {
    expect(() =>
      parseKnowledgeBuild(build, { ...parent, versionId: ids.version, buildId: ids.job }),
    ).toThrow(KnowledgeContractError)
  })

  it('rejects a different operation under the same document', () => {
    expect(() => parseKnowledgeOperation(operation, { ...parent, operationId: ids.job })).toThrow(
      KnowledgeContractError,
    )
  })
})

describe('safe knowledge errors', () => {
  it.each([
    'FORBIDDEN',
    'NOT_FOUND',
    'QUOTA_EXCEEDED',
    'VERSION_CONFLICT',
    'UNSUPPORTED_FORMAT',
    'OCR_REQUIRED',
    'SERVICE_UNAVAILABLE',
  ])('preserves distinct actionable error code %s', (code) =>
    expect(parseKnowledgeError({ code, requestId: null })).toEqual({ code, requestId: null }),
  )

  it('allows a failed operation with a safe error but never vendor details', () => {
    const error = { code: 'OCR_REQUIRED', requestId: ids.job }
    expect(parseKnowledgeOperation({ ...operation, phase: 'failed', error }, parent).error).toEqual(
      error,
    )
    expect(() => parseKnowledgeError({ ...error, message: 'Bearer private-token' })).toThrow(
      KnowledgeContractError,
    )
    expect(() => parseKnowledgeError({ code: 'EMPTY', requestId: null })).toThrow(
      KnowledgeContractError,
    )
  })
})
