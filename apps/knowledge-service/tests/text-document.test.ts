import { expect, it } from 'vitest'
import {
  parseKnowledgeCoverage,
  parseKnowledgeLocator,
  sliceKnowledgeCodePoints,
} from '@genoffice/knowledge-contract'
import { parseKnowledgeTextDocument } from '../src/parsing'
import { textInput, textLimits } from './text-fixtures'

it('produces deterministic complete TXT DocIR from the original bytes rather than a flattened attachment', () => {
  const input = textInput('abc')
  const document = parseKnowledgeTextDocument(input, textLimits)
  expect(document).toMatchObject({
    schemaVersion: 1,
    format: 'txt',
    parserRevision: 'txt-utf8-lines-v1',
    encoding: 'utf-8',
    sourceHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    textHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    sourceBytes: { unit: 'bytes', value: '3' },
    removedBomBytes: 0,
    text: 'abc',
    textCodePointLength: 3,
    coverage: {
      scope: 'document',
      unit: 'line',
      status: 'complete',
      expectedUnits: 1,
      completedUnits: 1,
      missingUnits: 0,
      excludedUnits: 0,
      warnings: [],
    },
  })
  expect(document.units).toHaveLength(1)
  expect(document.units[0]).toMatchObject({
    ordinal: 0,
    kind: 'line',
    text: 'abc',
    sourceByteRange: { unit: 'byte', origin: 0, start: 0, end: 3 },
    documentSpan: { unit: 'unicode_code_point', origin: 0, start: 0, end: 3 },
    locator: {
      format: 'txt',
      span: { start: 0, end: 3 },
      headingPath: [],
      lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 1, end: 1 },
    },
  })
  expect(document).toEqual(parseKnowledgeTextDocument(input, textLimits))
  expect(
    parseKnowledgeCoverage(document.coverage, {
      format: document.format,
      sourceHash: document.sourceHash,
      parserRevision: document.parserRevision,
    }),
  ).toEqual(document.coverage)
  const unit = document.units[0]!
  expect(
    parseKnowledgeLocator(unit.locator, {
      format: 'txt',
      sourceHash: document.sourceHash,
      textHash: unit.textHash,
      textCodePointLength: 3,
    }),
  ).toEqual(unit.locator)
})

it('preserves CJK, astral code points and CRLF with independent byte and extracted-text ranges', () => {
  const input = textInput('甲😀\r\n乙\n')
  const document = parseKnowledgeTextDocument(input, textLimits)
  expect(document.text).toBe('甲😀\r\n乙\n')
  expect(document.textCodePointLength).toBe(6)
  expect(
    document.units.map((unit) => ({
      text: unit.text,
      bytes: unit.sourceByteRange,
      span: unit.documentSpan,
      lines: unit.locator.lines,
      localSpan: unit.locator.span,
    })),
  ).toEqual([
    {
      text: '甲😀\r\n',
      bytes: { unit: 'byte', origin: 0, start: 0, end: 9 },
      span: { unit: 'unicode_code_point', origin: 0, start: 0, end: 4 },
      lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 1, end: 1 },
      localSpan: { unit: 'unicode_code_point', origin: 0, start: 0, end: 4 },
    },
    {
      text: '乙\n',
      bytes: { unit: 'byte', origin: 0, start: 9, end: 13 },
      span: { unit: 'unicode_code_point', origin: 0, start: 4, end: 6 },
      lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 2, end: 2 },
      localSpan: { unit: 'unicode_code_point', origin: 0, start: 0, end: 2 },
    },
  ])
  expect(document.coverage.expectedUnits).toBe(2)
  expect(new Set(document.units.map((unit) => unit.id)).size).toBe(2)
})

it.each([
  { text: 'a\rb\r\nc\n\nz', lines: ['a\r', 'b\r\n', 'c\n', '\n', 'z'] },
  { text: 'a\n', lines: ['a\n'] },
  { text: 'a\n\n', lines: ['a\n', '\n'] },
  { text: '\n a', lines: ['\n', ' a'] },
])('retains empty lines without inventing a terminal phantom line: $text', ({ text, lines }) => {
  const document = parseKnowledgeTextDocument(textInput(text), textLimits)
  expect(document.units.map((unit) => unit.text)).toEqual(lines)
  expect(document.coverage.completedUnits).toBe(lines.length)
})

it('records removal of only the initial UTF-8 BOM without rewriting interior characters', () => {
  const document = parseKnowledgeTextDocument(textInput('\uFEFFa\uFEFF\r\nb'), textLimits)
  expect(document.removedBomBytes).toBe(3)
  expect(document.text).toBe('a\uFEFF\r\nb')
  expect(
    document.units.map((unit) => [unit.sourceByteRange.start, unit.sourceByteRange.end]),
  ).toEqual([
    [3, 9],
    [9, 10],
  ])
  expect(document.sourceHash).not.toBe(document.textHash)
})

it('does not normalize combining characters or confuse graphemes with code points', () => {
  const text = 'e\u0301 👨‍👩‍👧‍👦\r\n'
  const document = parseKnowledgeTextDocument(textInput(text), textLimits)
  expect(document.text).toBe(text)
  expect(document.textCodePointLength).toBe(12)
  expect(document.units[0]?.locator.span.end).toBe(12)
})

it('maps byte offsets relative to the uploaded source view, not its backing allocation', () => {
  const bytes = new Uint8Array([0, 0xef, 0xbb, 0xbf, 97, 10, 98, 0])
  const document = parseKnowledgeTextDocument(textInput(bytes.subarray(1, 7)), textLimits)
  expect(document.text).toBe('a\nb')
  expect(
    document.units.map((unit) => [unit.sourceByteRange.start, unit.sourceByteRange.end]),
  ).toEqual([
    [3, 5],
    [5, 6],
  ])
  expect(document.sourceBytes.value).toBe('6')
})

it.each(['a', '甲', '😀', 'e\u0301', '\uFFFD', '\uFEFF内文'])(
  'round-trips every unit through both original bytes and extracted code points: %s',
  (fragment) => {
    const input = textInput(`\uFEFF${fragment}\r\n\n${fragment}\r末行`)
    const document = parseKnowledgeTextDocument(input, textLimits)
    expect(document.units.map((unit) => unit.text).join('')).toBe(document.text)
    let nextByte = 3
    let nextPoint = 0
    for (const unit of document.units) {
      expect(unit.sourceByteRange.start).toBe(nextByte)
      expect(unit.documentSpan.start).toBe(nextPoint)
      expect(
        new TextDecoder('utf-8', { ignoreBOM: true }).decode(
          input.bytes.subarray(unit.sourceByteRange.start, unit.sourceByteRange.end),
        ),
      ).toBe(unit.text)
      expect(sliceKnowledgeCodePoints(document.text, unit.documentSpan)).toBe(unit.text)
      nextByte = unit.sourceByteRange.end
      nextPoint = unit.documentSpan.end
    }
    expect(nextByte).toBe(input.bytes.byteLength)
    expect(nextPoint).toBe(document.textCodePointLength)
  },
)
