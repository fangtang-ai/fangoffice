import { choice, counter, invalid, object, record, type Decoder } from './validation.js'

const numeric38: Decoder<string> = (input, path) => {
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]{0,37})$/.test(input)) invalid(path)
  return input
}
const bytes = object({ unit: choice(['bytes']), value: counter })
const tokens = object({ unit: choice(['tokens']), value: counter })
const byteMilliseconds = object({ unit: choice(['byte_ms']), value: numeric38 })

export function parseKnowledgeQuantity(input: unknown) {
  const source = record(input, 'quantity')
  if (source.unit === 'bytes') return bytes(input, 'quantity')
  if (source.unit === 'tokens') return tokens(input, 'quantity')
  if (source.unit === 'byte_ms') return byteMilliseconds(input, 'quantity')
  invalid('quantity.unit')
}

export type KnowledgeQuantity = ReturnType<typeof parseKnowledgeQuantity>
