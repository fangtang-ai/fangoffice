import { parseKnowledgeOperation } from './lifecycle'
import { knowledgeSourceFormat } from './core'
import { parseKnowledgeDocumentTarget, type KnowledgeDocumentTarget } from './requests'
import {
  counter,
  invalid,
  literal,
  object,
  positiveCounter,
  text,
  timestamp,
  uuid,
} from './validation'

const uploadFields = {
  operationId: uuid,
  idempotencyKey: text(128),
  expectedGeneration: counter,
  declaredBytes: positiveCounter,
  format: knowledgeSourceFormat,
}
const uploadRequest = object(uploadFields)
const completionRequest = object({
  ...uploadFields,
  sourceHash: (value: unknown, path: string) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(path)
    return value
  },
})
const preparation = object({
  status: literal('prepared'),
  maximumBytes: positiveCounter,
  expiresAt: timestamp,
  format: knowledgeSourceFormat,
})

export function parseKnowledgeUploadRequest(input: unknown) {
  return uploadRequest(input, 'uploadRequest')
}

export function parseKnowledgeUploadCompletionRequest(input: unknown) {
  return completionRequest(input, 'uploadCompletionRequest')
}

export function parseKnowledgeUploadCompletion(input: unknown, parent: KnowledgeDocumentTarget, requestInput: unknown) {
  const target = parseKnowledgeDocumentTarget(parent)
  const expected = parseKnowledgeUploadCompletionRequest(requestInput)
  const result = object({ operation: (value) => parseKnowledgeOperation(value, { ...target, operationId: expected.operationId }) })(input, 'uploadCompletion')
  if (result.operation.kind !== 'upload' || result.operation.expectedGeneration !== expected.expectedGeneration ||
      !['queued', 'parsing', 'indexing', 'publishing', 'ready'].includes(result.operation.phase)) invalid('uploadCompletion.operation')
  return result
}

export function parseKnowledgeUploadPreparation(
  input: unknown,
  parent: KnowledgeDocumentTarget,
  requestInput: unknown,
) {
  const target = parseKnowledgeDocumentTarget(parent)
  const expected = parseKnowledgeUploadRequest(requestInput)
  const result = object({
    operation: (value) => parseKnowledgeOperation(value, target),
    preparation,
  })(input, 'uploadPreparation')
  if (
    result.operation.kind !== 'upload' ||
    result.operation.phase !== 'uploading' ||
    result.operation.targetVersionId !== null ||
    result.operation.expectedGeneration !== expected.expectedGeneration ||
    result.preparation.maximumBytes !== expected.declaredBytes ||
    result.preparation.format !== expected.format
  )
    invalid('uploadPreparation')
  return result
}

export type KnowledgeUploadRequest = ReturnType<typeof parseKnowledgeUploadRequest>
export type KnowledgeUploadCompletionRequest = ReturnType<typeof parseKnowledgeUploadCompletionRequest>
export type KnowledgeUploadCompletion = ReturnType<typeof parseKnowledgeUploadCompletion>
export type KnowledgeUploadPreparation = ReturnType<typeof parseKnowledgeUploadPreparation>
