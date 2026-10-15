import { expect, it } from 'vitest'
import { parseKnowledgeCoverage, parseKnowledgeLocator } from '@genoffice/knowledge-contract'
import { parseKnowledgeMarkdownDocument } from '../src/parsing'
import { textInput, textLimits } from './text-fixtures'

it('produces deterministic complete Markdown DocIR with heading, paragraph and table blocks', () => {
  const input = textInput('# 标题\n\n正文第一段。\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n')
  const document = parseKnowledgeMarkdownDocument(input, textLimits)
  expect(document).toMatchObject({
    schemaVersion: 1,
    format: 'md',
    parserRevision: 'markdown-atx-blocks-v1',
    encoding: 'utf-8',
    textCodePointLength: 48,
    coverage: {
      scope: 'document',
      unit: 'line',
      status: 'complete',
      expectedUnits: 5,
      completedUnits: 5,
      missingUnits: 0,
      excludedUnits: 0,
      warnings: [],
    },
  })
  expect(
    document.units.map((unit) => ({
      kind: unit.kind,
      text: unit.text,
      lines: unit.locator.lines,
      path: unit.locator.headingPath,
      span: unit.documentSpan,
      bytes: unit.sourceByteRange,
    })),
  ).toEqual([
    {
      kind: 'heading',
      text: '# 标题\n',
      lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 1, end: 1 },
      path: [],
      span: { unit: 'unicode_code_point', origin: 0, start: 0, end: 5 },
      bytes: { unit: 'byte', origin: 0, start: 0, end: 9 },
    },
    {
      kind: 'paragraph',
      text: '正文第一段。\n',
      lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 3, end: 3 },
      path: ['标题'],
      span: { unit: 'unicode_code_point', origin: 0, start: 6, end: 13 },
      bytes: { unit: 'byte', origin: 0, start: 10, end: 29 },
    },
    {
      kind: 'table',
      text: '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n',
      lines: { unit: 'line', origin: 1, boundary: 'inclusive', start: 5, end: 7 },
      path: ['标题'],
      span: { unit: 'unicode_code_point', origin: 0, start: 14, end: 48 },
      bytes: { unit: 'byte', origin: 0, start: 30, end: 68 },
    },
  ])
  expect(document).toEqual(parseKnowledgeMarkdownDocument(input, textLimits))
  expect(
    parseKnowledgeCoverage(document.coverage, {
      format: document.format,
      sourceHash: document.sourceHash,
      parserRevision: document.parserRevision,
    }),
  ).toEqual(document.coverage)
  const table = document.units[2]!
  expect(
    parseKnowledgeLocator(table.locator, {
      format: 'md',
      sourceHash: document.sourceHash,
      textHash: table.textHash,
      textCodePointLength: 34,
    }),
  ).toEqual(table.locator)
})

it('keeps the ATX heading stack as derived navigation while raw heading text stays untouched', () => {
  const input = textInput('# 甲\n## 乙\n段落一\n### 丙\n段落二\n## 丁\n段落三\n')
  const document = parseKnowledgeMarkdownDocument(input, textLimits)
  expect(
    document.units.map((unit) => ({
      kind: unit.kind,
      text: unit.text.trim(),
      path: unit.locator.headingPath,
    })),
  ).toEqual([
    { kind: 'heading', text: '# 甲', path: [] },
    { kind: 'heading', text: '## 乙', path: ['甲'] },
    { kind: 'paragraph', text: '段落一', path: ['甲', '乙'] },
    { kind: 'heading', text: '### 丙', path: ['甲', '乙'] },
    { kind: 'paragraph', text: '段落二', path: ['甲', '乙', '丙'] },
    { kind: 'heading', text: '## 丁', path: ['甲'] },
    { kind: 'paragraph', text: '段落三', path: ['甲', '丁'] },
  ])
})

it('derives a preview that cannot carry HTML or scripts while cited units keep the raw source', () => {
  const input = textInput('# 报告\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n')
  const document = parseKnowledgeMarkdownDocument(input, textLimits)
  expect(document.preview).not.toMatch(/<|>/)
  expect(document.preview).toContain('&lt;script&gt;')
  const script = document.units.find((unit) => unit.text.includes('<script>'))!
  expect(script.text).toContain('<script>alert(1)</script>')
  expect(script.locator.lines.start).toBe(3)
  expect(script.locator.lines.end).toBe(3)
  expect(document.preview).toEqual(parseKnowledgeMarkdownDocument(input, textLimits).preview)
})
