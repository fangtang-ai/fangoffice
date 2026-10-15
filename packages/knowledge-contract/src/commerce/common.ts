import { parseKnowledgeQuantity } from '../quantities'
import {
  counter,
  invalid,
  literal,
  object,
  sha256,
  timestamp,
  uuid,
  type Decoder,
} from '../validation'

export const product = literal('knowledge_base')
export const empty: Decoder<null> = (input, path) => {
  if (input !== null) invalid(path)
  return null
}

export function storageQuantity(input: unknown) {
  const quantity = parseKnowledgeQuantity(input)
  if (quantity.unit !== 'byte_ms') invalid('quantity.unit')
  return quantity
}

export function tokenQuantity(input: unknown) {
  const quantity = parseKnowledgeQuantity(input)
  if (quantity.unit !== 'tokens') invalid('quantity.unit')
  return quantity
}

const storageWindow = object({
  kind: literal('storage_window'),
  windowId: uuid,
  startAt: timestamp,
  endAt: timestamp,
  timezone: literal('Asia/Shanghai'),
  openingSequence: counter,
  closingSequence: counter,
  eventSetHash: sha256,
})

export function parseStorageWindow(input: unknown) {
  const result = storageWindow(input, 'storageWindow')
  if (
    result.startAt >= result.endAt ||
    BigInt(result.openingSequence) > BigInt(result.closingSequence)
  )
    invalid('storageWindow.range')
  return result
}

export function matchSnapshot(actual: unknown, expected: unknown, path: string) {
  // Callers pass bounded decoded snapshots, whose field order is canonical.
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid(path)
}
