import { expect, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeUploadCompletion, parseKnowledgeUploadCompletionRequest } from '../src'

const request = {
  operationId: '019a1234-0000-7000-8000-000000000003',
  idempotencyKey: 'synthetic-upload',
  expectedGeneration: '9007199254740993',
  declaredBytes: '9007199254740995',
  format: 'txt',
  sourceHash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
}

it('binds completion to the original exact declaration and source SHA-256, without storage authority', () => {
  expect(parseKnowledgeUploadCompletionRequest(request)).toEqual(request)
})

const target = { spaceId: '019a1234-0000-7000-8000-000000000001', documentId: '019a1234-0000-7000-8000-000000000002' }
const completed = { operation: {
  id: request.operationId, ...target, kind: 'upload', phase: 'queued',
  expectedGeneration: request.expectedGeneration,
  targetVersionId: '019a1234-0000-7000-8000-000000000004', error: null,
} }

it('accepts a queued completion or a later committed phase bound to the same operation', () => {
  expect(parseKnowledgeUploadCompletion(completed, target, request)).toEqual(completed)
  const ready = { operation: { ...completed.operation, phase: 'ready' } }
  expect(parseKnowledgeUploadCompletion(ready, target, request)).toEqual(ready)
})

it.each([
  { sourceHash: 'invalid' }, { sourceHash: 'A'.repeat(64) }, { sourceHash: 'a'.repeat(63) },
  { ownerId: 'forged' }, { bucket: 'forged' }, { key: 'forged' }, { chunks: '1' },
  { physicalBytes: '16' }, { expiresAt: '2026-10-21T00:00:00.000Z' },
  { declaredBytes: 4 }, { expectedGeneration: '01' },
])('rejects forged completion authority or malformed declarations %#', (override) => {
  expect(() => parseKnowledgeUploadCompletionRequest({ ...request, ...override })).toThrow(KnowledgeContractError)
})

it.each([
  { id: target.spaceId }, { documentId: target.spaceId }, { spaceId: target.documentId },
  { expectedGeneration: '0' }, { phase: 'uploading', targetVersionId: null },
  { phase: 'cancelled' }, { kind: 'replace' },
])('rejects a completion for a different identity or uncommitted phase %#', (override) => {
  expect(() => parseKnowledgeUploadCompletion({ operation: { ...completed.operation, ...override } }, target, request)).toThrow(KnowledgeContractError)
})
