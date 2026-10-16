import { getTableConfig } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
import { kbChunkEmbeddings, kbChunks, kbChunkSources, kbSourceUnits } from '../src/schema'
import { checksOf, foreignKeysOf, primaryColumns } from './schema-fixtures'

it('keeps source parents and ordered chunk spans inside the same owner/build', () => {
  expect(primaryColumns(kbSourceUnits)).toEqual(['owner_id', 'build_id', 'id'])
  expect(primaryColumns(kbChunks)).toEqual(['owner_id', 'build_id', 'id'])
  expect(foreignKeysOf(kbSourceUnits).kb_source_units_parent_fk).toMatchObject({
    columns: ['owner_id', 'build_id', 'parent_id'],
    target: 'kb_source_units',
    foreignColumns: ['owner_id', 'build_id', 'id'],
  })
  expect(foreignKeysOf(kbChunkSources)).toMatchObject({
    kb_chunk_sources_chunk_fk: {
      columns: ['owner_id', 'build_id', 'chunk_id'],
      target: 'kb_chunks',
      foreignColumns: ['owner_id', 'build_id', 'id'],
    },
    kb_chunk_sources_unit_fk: {
      columns: ['owner_id', 'build_id', 'source_unit_id'],
      target: 'kb_source_units',
      foreignColumns: ['owner_id', 'build_id', 'id'],
    },
  })
  expect(checksOf(kbChunkSources).kb_chunk_sources_offsets_check).toMatch(
    /start_cp.*>= 0.*end_cp.*>.*start_cp/,
  )
  expect(
    getTableConfig(kbSourceUnits).uniqueConstraints.map((key) =>
      key.columns.map((column) => column.name),
    ),
  ).toContainEqual(['owner_id', 'build_id', 'ordinal'])
  expect(kbSourceUnits.parentId.notNull).toBe(false)
})

it('uses a non-null 1024-dimensional thin vector table with no ANN or duplicate global identities', () => {
  expect(primaryColumns(kbChunkEmbeddings)).toEqual(['owner_id', 'build_id', 'chunk_id'])
  expect(foreignKeysOf(kbChunkEmbeddings).kb_chunk_embeddings_chunk_fk).toMatchObject({
    columns: ['owner_id', 'build_id', 'chunk_id'],
    target: 'kb_chunks',
    foreignColumns: ['owner_id', 'build_id', 'id'],
  })
  expect(kbChunkEmbeddings.embedding.getSQLType()).toBe('vector(1024)')
  expect(kbChunkEmbeddings.embedding.notNull).toBe(true)
  expect(getTableConfig(kbChunks).columns.map((column) => column.name)).not.toContain('embedding')
  expect(getTableConfig(kbChunkEmbeddings).indexes).toEqual([])
  expect(
    getTableConfig(kbChunks).indexes.find((index) => index.config.name === 'kb_chunks_search_idx')
      ?.config.method,
  ).toBe('gin')
  expect(kbChunks.searchVector.getSQLType()).toBe('tsvector')
  expect(kbChunks.textHash.getSQLType()).toBe('bytea')
})
