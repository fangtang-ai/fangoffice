import { createKnowledgePrincipal } from '../src'

export const now = Date.parse('2026-10-15T00:00:00.000Z')
export const later = '2026-10-15T01:00:00.000Z'
export const ownerId = 'synthetic-owner-A'
export const otherOwnerId = 'synthetic-owner-B'
export const ids = {
  space: '019a1234-0000-7000-8000-000000000001',
  document: '019a1234-0000-7000-8000-000000000003',
  version: '019a1234-0000-7000-8000-000000000004',
  build: '019a1234-0000-7000-8000-000000000005',
  operation: '019a1234-0000-7000-8000-000000000006',
}
export const target = { spaceId: ids.space, documentId: ids.document }
export const scope = { kind: 'documents', documents: [target] }
export function principal() {
  return createKnowledgePrincipal(
    {
      issuer: 'https://issuer.invalid/oidc',
      audiences: ['https://account.invalid'],
      subject: ownerId,
      expiresAt: now + 3600000,
      permissions: [],
    },
    { issuer: 'https://issuer.invalid/oidc', audience: 'https://account.invalid' },
    now,
  )
}
export const space = { id: ids.space, title: '合成空间', state: 'active' }
export const document = {
  id: ids.document,
  spaceId: ids.space,
  title: '合成资料',
  tags: [],
  purpose: 'facts',
  generation: '1',
  active: { versionId: ids.version, buildId: ids.build, treeBuildId: null },
  desired: null,
  deletedAt: null,
}
export const version = {
  id: ids.version,
  ...target,
  operationId: ids.operation,
  versionNo: '1',
  format: 'txt',
  sizeBytes: '10',
  sha256: 'a'.repeat(64),
  purgedAt: null,
}
export const build = {
  id: ids.build,
  ...target,
  versionId: ids.version,
  operationId: ids.operation,
  indexProfileId: ids.space,
  parserRevision: 'synthetic-1',
  expectedGeneration: '1',
  jobId: ids.operation,
  retryCount: 0,
  status: 'sealed',
  manifestHash: 'b'.repeat(64),
}
export function resourceFacts() {
  return {
    space: { ownerId, value: space },
    document: { ownerId, value: document },
    version: { ownerId, value: version },
    build: { ownerId, value: build },
  }
}
