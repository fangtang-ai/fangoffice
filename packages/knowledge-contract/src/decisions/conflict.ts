import { literal, nullable, object, sha256, text, timestamp, uuid } from '../validation.js'

export const conflictCandidate = object({
  id: uuid,
  difference: text(1000),
  alignment: object({
    subject: text(200),
    metric: text(200),
    unit: text(64),
    period: text(128),
    conditions: text(1000),
  }),
  mcp: object({
    source: literal('policy_mcp'),
    callId: uuid,
    evidenceId: text(128),
    version: text(128),
    title: text(200),
    excerpt: text(2000),
    evidenceHash: sha256,
    observedAt: timestamp,
    validUntil: timestamp,
    applicability: text(1000),
  }),
  private: object({
    source: literal('knowledge_base'),
    purpose: literal('facts'),
    spaceId: uuid,
    documentId: uuid,
    versionId: uuid,
    buildId: uuid,
    sourceUnitId: uuid,
    sourceHash: sha256,
    textHash: sha256,
    title: text(200),
    excerpt: text(2000),
    versionLabel: text(128),
    versionAt: nullable(timestamp),
    applicability: text(1000),
  }),
})

export type KnowledgeConflictCandidate = ReturnType<typeof conflictCandidate>
