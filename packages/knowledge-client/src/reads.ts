import {
  parseKnowledgeBuild,
  parseKnowledgeBuildTarget,
  parseKnowledgeDocumentTarget,
  parseKnowledgeOperation,
  parseKnowledgeOperationTarget,
  parseKnowledgePage,
  parseKnowledgePagination,
  parseKnowledgeQuota,
  parseKnowledgeSourceUnit,
  parseKnowledgeSourceUnitTarget,
  parseKnowledgeVersion,
  parseKnowledgeVersionTarget,
} from '@genoffice/knowledge-contract'
import type { createKnowledgeTransport } from './transport.js'
import type { KnowledgeRequestOptions } from './types.js'

export function createHistoryReads(request: ReturnType<typeof createKnowledgeTransport>) {
  return {
    async getSourceUnit(input: unknown, options: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeSourceUnitTarget(input)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}/versions/${target.versionId}/builds/${target.buildId}/sources/${target.sourceUnitId}`,
        (value) => parseKnowledgeSourceUnit(value, target),
        options,
      )
    },
    async listVersions(
      input: unknown,
      pageInput: unknown = {},
      options: KnowledgeRequestOptions = {},
    ) {
      const target = parseKnowledgeDocumentTarget(input)
      const pagination = parseKnowledgePagination(pageInput)
      const query = new URLSearchParams({ limit: String(pagination.limit) })
      if (pagination.cursor !== null) query.set('cursor', pagination.cursor)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}/versions?${query}`,
        (value) =>
          parseKnowledgePage(value, (item) => parseKnowledgeVersion(item, target), pagination),
        options,
      )
    },
    async getVersion(input: unknown, options: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeVersionTarget(input)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}/versions/${target.versionId}`,
        (value) => parseKnowledgeVersion(value, target),
        options,
      )
    },
    async getBuild(input: unknown, options: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeBuildTarget(input)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}/versions/${target.versionId}/builds/${target.buildId}`,
        (value) => parseKnowledgeBuild(value, target),
        options,
      )
    },
    async getOperation(input: unknown, options: KnowledgeRequestOptions = {}) {
      const target = parseKnowledgeOperationTarget(input)
      return request(
        `/spaces/${target.spaceId}/documents/${target.documentId}/operations/${target.operationId}`,
        (value) => parseKnowledgeOperation(value, target),
        options,
      )
    },
    async getQuota(options: KnowledgeRequestOptions = {}) {
      return request('/quota', parseKnowledgeQuota, options)
    },
  }
}
