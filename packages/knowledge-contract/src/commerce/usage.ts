import { choice, literal, object, record } from '../validation.js'
import { empty, storageQuantity, tokenQuantity } from './common.js'

const unknownUsage = object({ source: literal('unknown'), quantity: empty })
const storageUsage = object({
  source: choice(['reconciled', 'estimated']),
  quantity: storageQuantity,
})
const embeddingUsage = object({
  source: choice(['provider_reported', 'reconciled', 'estimated']),
  quantity: tokenQuantity,
})

export function parseStorageUsage(input: unknown) {
  return record(input, 'usage').source === 'unknown'
    ? unknownUsage(input, 'usage')
    : storageUsage(input, 'usage')
}

export function parseEmbeddingUsage(input: unknown) {
  return record(input, 'usage').source === 'unknown'
    ? unknownUsage(input, 'usage')
    : embeddingUsage(input, 'usage')
}
