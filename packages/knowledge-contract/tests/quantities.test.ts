import { describe, expect, expectTypeOf, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeQuantity } from '../src'

describe('lossless quantities at HTTP/IPC boundaries', () => {
  it.each([
    { unit: 'bytes', value: '9007199254740993' },
    { unit: 'tokens', value: '9223372036854775807' },
    { unit: 'byte_ms', value: '92771293593600000' },
    { unit: 'byte_ms', value: '99999999999999999999999999999999999999' },
    { unit: 'bytes', value: '0' },
  ])('preserves canonical integer strings and their units: %j', (quantity) => {
    const result = parseKnowledgeQuantity(quantity)
    expect(result).toEqual(quantity)
    expect(JSON.parse(JSON.stringify(result))).toEqual(quantity)
    expectTypeOf(result.value).toBeString()
    expectTypeOf(result.unit).toEqualTypeOf<'bytes' | 'tokens' | 'byte_ms'>()
  })

  it.each([
    { unit: 'bytes', value: '9223372036854775808' },
    { unit: 'tokens', value: '9223372036854775808' },
    { unit: 'byte_ms', value: '100000000000000000000000000000000000000' },
    { unit: 'byte_ms', value: '01' },
    { unit: 'bytes', value: 1024 },
    { unit: 'tokens', value: null },
    { unit: 'bytes', value: '-1' },
    { unit: 'byte_ms', value: '1.0' },
    { unit: 'byte_ms', value: '1e20' },
    { unit: 'bytes', value: ' 1' },
    { unit: 'bytes', value: '+1' },
    { unit: 'GB', value: '1' },
    { unit: 'GiB_days', value: '1' },
    { unit: 'bytes', value: '1', ownerId: 'forged' },
  ])('rejects unsafe, unknown or mismatched scalar representations: %j', (quantity) => {
    expect(() => parseKnowledgeQuantity(quantity)).toThrow(KnowledgeContractError)
  })

  it('rejects a native BigInt instead of leaking it into a JSON contract', () => {
    expect(() => parseKnowledgeQuantity({ unit: 'tokens', value: 1n })).toThrow(
      KnowledgeContractError,
    )
  })
})
