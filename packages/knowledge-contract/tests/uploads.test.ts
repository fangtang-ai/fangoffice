import { expect, it } from 'vitest'
import {
  KnowledgeContractError,
  parseKnowledgeUploadRequest,
  parseKnowledgeUploadPreparation,
} from '../src'

const spaceId = '019a1234-0000-7000-8000-000000000001'
const documentId = '019a1234-0000-7000-8000-000000000002'
const operationId = '019a1234-0000-7000-8000-000000000003'
const target = { spaceId, documentId }
const request = {
  operationId,
  idempotencyKey: 'synthetic-upload',
  expectedGeneration: '9007199254740993',
  declaredBytes: '9007199254740995',
  format: 'txt',
}
const preparation = {
  operation: {
    id: operationId,
    ...target,
    kind: 'upload',
    phase: 'uploading',
    expectedGeneration: request.expectedGeneration,
    targetVersionId: null,
    error: null,
  },
  preparation: {
    status: 'prepared',
    maximumBytes: request.declaredBytes,
    format: 'txt',
    expiresAt: '2026-10-20T12:15:00.000Z',
  },
}

it('preserves exact upload declarations and validates a preparation, not an object grant', () => {
  expect(parseKnowledgeUploadRequest(request)).toEqual(request)
  expect(parseKnowledgeUploadPreparation(preparation, target, request)).toEqual(preparation)
  expect(() =>
    parseKnowledgeUploadPreparation(
      { ...preparation, preparation: { ...preparation.preparation, key: 'forged' } },
      target,
      request,
    ),
  ).toThrow(KnowledgeContractError)
  expect(() =>
    parseKnowledgeUploadPreparation(preparation, { ...target, documentId: operationId }, request),
  ).toThrow(KnowledgeContractError)
  expect(() =>
    parseKnowledgeUploadPreparation(preparation, target, { ...request, declaredBytes: '4' }),
  ).toThrow(KnowledgeContractError)
})

it.each([
  { declaredBytes: '0' },
  { declaredBytes: 4 },
  { declaredBytes: '9223372036854775808' },
  { expectedGeneration: '01' },
  { idempotencyKey: ' ' },
  { idempotencyKey: 'x'.repeat(129) },
  { format: 'exe' },
  { ownerId: 'forged' },
  { bucket: 'forged' },
  { key: 'forged' },
])('rejects invalid or caller-controlled upload declarations %#', (override) => {
  expect(() => parseKnowledgeUploadRequest({ ...request, ...override })).toThrow(
    KnowledgeContractError,
  )
})
