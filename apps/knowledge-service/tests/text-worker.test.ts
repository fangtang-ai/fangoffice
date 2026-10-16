import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it, vi } from 'vitest'
import { parseKnowledgeTextDocument } from '../src/parsing'
import { textInput, textLimits } from './text-fixtures'

let parser: typeof import('../src/parsing')

beforeAll(async () => {
  const directory = new URL('../.build/text-tests/', import.meta.url)
  const nodeTarget = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim()
  await build({
    absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
    entryPoints: { parser: 'src/parsing/index.ts', 'text-worker': 'src/parsing/text-worker.ts' },
    outdir: fileURLToPath(directory),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: `node${nodeTarget}`,
    format: 'esm',
  })
  parser = await import(new URL('parser.mjs', directory).href)
})

it('executes the same complete DocIR contract in a real isolated worker without detaching caller bytes', async () => {
  const input = textInput('甲😀\r\n第二行\n')
  const expected = parseKnowledgeTextDocument(input, textLimits)
  const document = await parser.parseKnowledgeTextInWorker(input, textLimits)
  expect(document).toEqual(expected)
  expect(input.bytes.byteLength).toBe(19)
  expect(new TextDecoder().decode(input.bytes)).toBe('甲😀\r\n第二行\n')
})

it('snapshots only the visible source view before transferring it to the parser', async () => {
  const storage = new Uint8Array([0, 97, 98, 99, 0])
  const input = textInput(storage.subarray(1, 4))
  const pending = parser.parseKnowledgeTextInWorker(input, textLimits)
  storage[1] = 120
  expect((await pending).text).toBe('abc')
  expect(storage.byteLength).toBe(5)
})

it.each([
  { input: textInput(new Uint8Array([0xff])), reason: 'INVALID_UTF8', code: 'INCOMPLETE_CONTENT' },
  { input: textInput(''), reason: 'EMPTY_CONTENT', code: 'EMPTY_CONTENT' },
  {
    input: { ...textInput('synthetic-private-text'), sourceHash: 'a'.repeat(64) },
    reason: 'SOURCE_MISMATCH',
    code: 'INVALID_REQUEST',
  },
])(
  'returns stable parse failure metadata without any original text or partial DocIR',
  async ({ input, reason, code }) => {
    await expect(parser.parseKnowledgeTextInWorker(input, textLimits)).rejects.toMatchObject({
      reason,
      code,
      message: reason,
    })
  },
)

it('cancels before starting and while running, then releases the worker slot', async () => {
  const preCancelled = new AbortController()
  preCancelled.abort()
  await expect(
    parser.parseKnowledgeTextInWorker(textInput('abc'), textLimits, {
      signal: preCancelled.signal,
    }),
  ).rejects.toMatchObject({ reason: 'CANCELLED' })
  const active = new AbortController()
  const pending = parser.parseKnowledgeTextInWorker(textInput('abc'), textLimits, {
    signal: active.signal,
  })
  active.abort()
  await expect(pending).rejects.toMatchObject({ reason: 'CANCELLED' })
  expect((await parser.parseKnowledgeTextInWorker(textInput('abc'), textLimits)).text).toBe('abc')
})

it('bounds the whole worker lifecycle rather than returning partial output after its deadline', async () => {
  await expect(
    parser.parseKnowledgeTextInWorker(textInput('abc'), textLimits, { timeoutMs: 1 }),
  ).rejects.toMatchObject({ reason: 'TIMED_OUT', code: 'SERVICE_UNAVAILABLE' })
  expect(
    (await parser.parseKnowledgeTextInWorker(textInput('abc'), textLimits)).coverage.status,
  ).toBe('complete')
})

it('rejects a late result even when the event loop has not dispatched its deadline timer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await expect(
      parser.parseKnowledgeTextInWorker(textInput('abc'), textLimits, { timeoutMs: 1 }),
    ).rejects.toMatchObject({ reason: 'TIMED_OUT' })
  } finally {
    vi.useRealTimers()
  }
})

it('refuses excess concurrency without building an unbounded pending queue', async () => {
  const first = parser.parseKnowledgeTextInWorker(textInput('one'), textLimits)
  const second = parser.parseKnowledgeTextInWorker(textInput('two'), textLimits)
  try {
    await expect(
      parser.parseKnowledgeTextInWorker(textInput('three'), textLimits),
    ).rejects.toMatchObject({ reason: 'BUSY' })
  } finally {
    await Promise.all([first, second])
  }
  expect((await parser.parseKnowledgeTextInWorker(textInput('three'), textLimits)).text).toBe(
    'three',
  )
})

it.each([0, -1, NaN, Infinity, 30001])(
  'refuses invalid worker deadlines without consuming a slot: %s',
  async (timeoutMs) => {
    await expect(
      parser.parseKnowledgeTextInWorker(textInput('abc'), textLimits, { timeoutMs }),
    ).rejects.toMatchObject({ reason: 'INVALID_REQUEST' })
  },
)

it('preserves complete coverage and final line identity for a bounded large synthetic document', async () => {
  const input = textInput('第1条：100万元；例外保留。\r\n'.repeat(5000))
  const document = await parser.parseKnowledgeTextInWorker(input, {
    maxBytes: 1048576,
    maxCodePoints: 200000,
    maxLines: 5000,
  })
  expect(document.units).toHaveLength(5000)
  expect(document.coverage).toMatchObject({
    expectedUnits: 5000,
    completedUnits: 5000,
    status: 'complete',
  })
  expect(document.units[4999]?.locator.lines).toMatchObject({ start: 5000, end: 5000 })
  expect(document.units[4999]?.sourceByteRange.end).toBe(input.bytes.byteLength)
})
