import { expect, it } from 'vitest'
import { parseKnowledgeCapacity } from '../src'

it('shares exact nonnegative int64 capacity parsing with admission policies', () => {
  expect(parseKnowledgeCapacity({ files: '1', bytes: '9007199254740993', chunks: '0' })).toEqual({
    files: '1',
    bytes: '9007199254740993',
    chunks: '0',
  })
})

it.each([
  { files: 1, bytes: '0', chunks: '0' },
  { files: '1', bytes: '-1', chunks: '0' },
  { files: '1', bytes: '9223372036854775808', chunks: '0' },
  { files: '1', bytes: '0', chunks: '0', ownerId: 'forged' },
])('rejects unsafe or caller-extended capacity inputs', (input) => {
  expect(() => parseKnowledgeCapacity(input)).toThrow()
})
