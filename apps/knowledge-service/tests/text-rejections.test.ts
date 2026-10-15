import { expect, it } from 'vitest'
import { parseKnowledgeTextDocument } from '../src/parsing'
import { textInput, textLimits } from './text-fixtures'

it.each(['', ' \t\r\n', '\uFEFF', '\uFEFF\n'])(
  'refuses empty content instead of reporting complete coverage: %j',
  (text) => {
    expect(() => parseKnowledgeTextDocument(textInput(text), textLimits)).toThrow('EMPTY_CONTENT')
  },
)

it.each([[0xff], [0xc0, 0xaf], [0xe4, 0xb8], [0xed, 0xa0, 0x80], [0xff, 0xfe, 0x61, 0x00]])(
  'rejects malformed UTF-8 and unsupported encoding bytes: %j',
  (...bytes) => {
    expect(() => parseKnowledgeTextDocument(textInput(Uint8Array.from(bytes)), textLimits)).toThrow(
      'INVALID_UTF8',
    )
  },
)

it.each(['a\0b', 'a\u0001b', 'a\u007fb', 'a\u0080b'])(
  'does not admit binary/control data as trustworthy text: %j',
  (text) => {
    expect(() => parseKnowledgeTextDocument(textInput(text), textLimits)).toThrow('BINARY_CONTENT')
  },
)

it.each([
  { limits: { ...textLimits, maxBytes: 2 }, text: 'abc' },
  { limits: { ...textLimits, maxCodePoints: 2 }, text: '甲😀乙' },
  { limits: { ...textLimits, maxLines: 1 }, text: 'a\nb' },
])('refuses the whole document when a technical limit is exceeded', ({ limits, text }) => {
  expect(() => parseKnowledgeTextDocument(textInput(text), limits)).toThrow('LIMIT_EXCEEDED')
})

it('accepts exact byte/code-point/line limits rather than truncating', () => {
  const document = parseKnowledgeTextDocument(textInput('甲😀\n乙'), {
    maxBytes: 11,
    maxCodePoints: 4,
    maxLines: 2,
  })
  expect(document.text).toBe('甲😀\n乙')
  expect(document.coverage.status).toBe('complete')
})

it('refuses a source hash mismatch without exposing source text', () => {
  expect(() =>
    parseKnowledgeTextDocument(
      { ...textInput('synthetic-private-text'), sourceHash: 'a'.repeat(64) },
      textLimits,
    ),
  ).toThrow('SOURCE_MISMATCH')
})

it.each([
  null,
  {},
  { bytes: 'abc', sourceHash: 'a'.repeat(64) },
  { ...textInput('abc'), ownerId: 'forged-owner' },
  { ...textInput('abc'), sourceHash: 'A'.repeat(64) },
])('rejects malformed untrusted parse inputs', (input) => {
  expect(() => parseKnowledgeTextDocument(input, textLimits)).toThrow('INVALID_REQUEST')
})

it.each([
  null,
  {},
  { ...textLimits, maxBytes: 0 },
  { ...textLimits, maxCodePoints: 1.5 },
  { ...textLimits, maxLines: 20001 },
  { ...textLimits, maxBytes: 8388609 },
  { ...textLimits, maxCodePoints: Infinity },
  { ...textLimits, free: true },
])('requires an explicit bounded technical policy', (policy) => {
  expect(() => parseKnowledgeTextDocument(textInput('abc'), policy)).toThrow('INVALID_REQUEST')
})

it('does not parse bytes that another thread can mutate during hash verification', () => {
  const shared = new Uint8Array(new SharedArrayBuffer(3))
  shared.set([97, 98, 99])
  expect(() => parseKnowledgeTextDocument(textInput(shared), textLimits)).toThrow('INVALID_REQUEST')
})
