import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

import { textLines } from '../src/parsing/text-lines'
import { markdownBlocks } from '../src/parsing/markdown'
import { textParserRevision } from '../src/parsing/text-unit'
import { markdownParserRevision } from '../src/parsing/text-unit'
import { createKnowledgeBuildChunkizer, knowledgeUnitUuid } from '../src/runtime/build-chunks'

const SOURCE_HASH = 'f'.repeat(64)
const LIMITS = { maxBytes: 8 * 1024 * 1024, maxCodePoints: 4 * 1024 * 1024, maxLines: 20000 }

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function lineUnits(lines: readonly string[]) {
  return textLines(`${lines.join('\n')}\n`, SOURCE_HASH, 0, LIMITS).units
}

function mdUnits(markdown: string) {
  return markdownBlocks(markdown, SOURCE_HASH, 0, LIMITS).units
}

describe('createKnowledgeBuildChunkizer', () => {
  it('accepts budget 2000 and denies lower values', () => {
    assert.equal(createKnowledgeBuildChunkizer(2000, textParserRevision) instanceof Object, true)
    assert.throws(
      () => createKnowledgeBuildChunkizer(1999, textParserRevision),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'INVALID_REQUEST',
    )
  })

  it('packs whole units greedily up to the budget', () => {
    const chunkizer = createKnowledgeBuildChunkizer(2000, textParserRevision)
    const units = lineUnits(['x', 'y', 'z'])
    const { chunks, chunkSources } = chunkizer({
      parserRevision: textParserRevision,
      coverage: { scope: 'document' },
      units,
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunkSources.length, units.length)
    assert.equal(chunks[0].text, 'x\ny\nz\n')
    assert.equal(chunkSources[0].mapping, units[0].locator)
    assert.deepEqual(chunks[0].textHash, Buffer.from(sha256Hex('x\ny\nz\n'), 'hex'))
    assert.equal(chunks[0].ordinal, 0)
    assert.deepEqual(chunkSources[0], {
      chunkId: chunks[0].id,
      spanNo: 0,
      sourceUnitId: knowledgeUnitUuid(units[0].id),
      startCp: 0,
      endCp: 2,
      mapping: units[0].locator,
    })
  })

  it('opens a new chunk when the next unit would overflow', () => {
    const chunkizer = createKnowledgeBuildChunkizer(2000, textParserRevision)
    const first = `${'a'.repeat(1500)}\n`
    const second = `${'b'.repeat(600)}\n`
    const third = 'c\n'
    const units = lineUnits(['a'.repeat(1500), 'b'.repeat(600), 'c'])
    const { chunks, chunkSources } = chunkizer({
      parserRevision: textParserRevision,
      coverage: { scope: 'document' },
      units,
    })
    // 1501 + 601 = 2102 > 2000 → 第二块从 second 起（601+2=603）。
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].text, first)
    assert.equal(chunks[1].text, `${second}${third}`)
    assert.deepEqual(chunks[0].textHash, Buffer.from(sha256Hex(first), 'hex'))
    assert.deepEqual(chunks[1].textHash, Buffer.from(sha256Hex(`${second}${third}`), 'hex'))
    assert.equal(chunkSources.length, 3)
    assert.deepEqual(chunkSources[0], {
      chunkId: chunks[0].id,
      spanNo: 0,
      sourceUnitId: knowledgeUnitUuid(units[0].id),
      startCp: 0,
      endCp: 1501,
      mapping: units[0].locator,
    })
    assert.deepEqual(chunkSources[1], {
      chunkId: chunks[1].id,
      spanNo: 0,
      sourceUnitId: knowledgeUnitUuid(units[1].id),
      startCp: 0,
      endCp: 601,
      mapping: units[1].locator,
    })
    assert.deepEqual(chunkSources[2], {
      chunkId: chunks[1].id,
      spanNo: 1,
      sourceUnitId: knowledgeUnitUuid(units[2].id),
      startCp: 601,
      endCp: 603,
      mapping: units[2].locator,
    })
    assert.deepEqual(
      chunkSources.map((source) => source.sourceUnitId),
      units.map((unit) => knowledgeUnitUuid(unit.id)),
    )
  })

  it('keeps an oversized whole unit as its own chunk', () => {
    const chunkizer = createKnowledgeBuildChunkizer(2000, textParserRevision)
    const oversized = `${'d'.repeat(2500)}\n`
    const units = lineUnits(['d'.repeat(2500), 'e'])
    const { chunks, chunkSources } = chunkizer({
      parserRevision: textParserRevision,
      coverage: { scope: 'document' },
      units,
    })
    assert.equal(chunks.length, 2)
    assert.equal(chunks[0].text, oversized)
    assert.equal(chunks[1].text, 'e\n')
    assert.deepEqual(chunkSources[0], {
      chunkId: chunks[0].id,
      spanNo: 0,
      sourceUnitId: knowledgeUnitUuid(units[0].id),
      startCp: 0,
      endCp: 2501,
      mapping: units[0].locator,
    })
    assert.deepEqual(chunkSources[1], {
      chunkId: chunks[1].id,
      spanNo: 0,
      sourceUnitId: knowledgeUnitUuid(units[1].id),
      startCp: 0,
      endCp: 2,
      mapping: units[1].locator,
    })
  })

  it('denies documents without units', () => {
    const chunkizer = createKnowledgeBuildChunkizer(2000, textParserRevision)
    assert.throws(
      () => chunkizer({ parserRevision: textParserRevision, coverage: { scope: 'document' }, units: [] }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'EMPTY_CONTENT',
    )
  })

  it('rejects foreign parser revisions and non-document coverage', () => {
    const chunkizer = createKnowledgeBuildChunkizer(2000, textParserRevision)
    assert.throws(
      () => chunkizer({ parserRevision: 'other-revision', coverage: { scope: 'document' }, units: lineUnits(['x']) }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'SOURCE_MISMATCH',
    )
    assert.throws(
      () => chunkizer({ parserRevision: textParserRevision, coverage: { scope: 'selection' }, units: lineUnits(['x']) }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === 'INVALID_REQUEST',
    )
  })

  it('chunks markdown units with heading/paragraph/table kinds', () => {
    const chunkizer = createKnowledgeBuildChunkizer(2000, markdownParserRevision)
    const units = mdUnits('# a\n\nbody para\n\n| x | y |\n| - | - |\n| 1 | 2 |\n')
    const { chunks, chunkSources } = chunkizer({
      parserRevision: markdownParserRevision,
      coverage: { scope: 'document' },
      units,
    })
    assert.equal(units.length, 3)
    assert.equal(chunks.length, 1)
    assert.equal(chunkSources.length, 3)
    assert.equal(chunks[0].text, '# a\nbody para\n| x | y |\n| - | - |\n| 1 | 2 |\n')
    assert.deepEqual(
      chunkSources.map((source) => source.sourceUnitId),
      units.map((unit) => knowledgeUnitUuid(unit.id)),
    )
  })
})