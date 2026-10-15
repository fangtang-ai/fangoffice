import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import { parseKnowledgeMarkdownDocument } from '../src/parsing'
import { textInput, textLimits } from './text-fixtures'

let parser: typeof import('../src/parsing')

beforeAll(async () => {
  const directory = new URL('../.build/markdown-tests/', import.meta.url)
  await build({
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: {
      parser: 'src/parsing/index.ts',
      'markdown-worker': 'src/parsing/markdown-worker.ts',
    },
    outdir: fileURLToPath(directory),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22.12',
    format: 'esm',
  })
  parser = await import(new URL('parser.mjs', directory).href)
})

it('executes the same complete Markdown DocIR contract in a real isolated worker without detaching caller bytes', async () => {
  const input = textInput('# 标题\n\n正文😀\n')
  const expected = parseKnowledgeMarkdownDocument(input, textLimits)
  const document = await parser.parseKnowledgeMarkdownInWorker(input, textLimits)
  expect(document).toEqual(expected)
  expect(input.bytes.byteLength).toBeGreaterThan(0)
  expect(new TextDecoder().decode(input.bytes)).toBe('# 标题\n\n正文😀\n')
})

it('snapshots only the visible source view before transferring it to the parser', async () => {
  const storage = new Uint8Array([0, 97, 98, 99, 0])
  const input = textInput(storage.subarray(1, 4))
  const pending = parser.parseKnowledgeMarkdownInWorker(input, textLimits)
  storage[1] = 120
  expect((await pending).text).toBe('abc')
  expect(storage.byteLength).toBe(5)
})

it.each([
  {
    input: textInput(new Uint8Array([0xff])),
    reason: 'INVALID_UTF8',
    code: 'INCOMPLETE_CONTENT',
  },
  { input: textInput(''), reason: 'EMPTY_CONTENT', code: 'EMPTY_CONTENT' },
])(
  'returns stable markdown parse failure metadata without any original text or partial DocIR',
  async ({ input, reason, code }) => {
    await expect(parser.parseKnowledgeMarkdownInWorker(input, textLimits)).rejects.toMatchObject({
      reason,
      code,
      message: reason,
    })
  },
)

it('honours cancellation and deadline with the shared bounded worker machinery', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    parser.parseKnowledgeMarkdownInWorker(textInput('# 甲\n'), textLimits, {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ reason: 'CANCELLED' })
  const input = textInput('# 甲\n\n' + '段落\n'.repeat(20))
  await expect(
    parser.parseKnowledgeMarkdownInWorker(input, textLimits, { timeoutMs: 1 }),
  ).rejects.toMatchObject({ reason: 'TIMED_OUT' })
})
