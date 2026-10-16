import { getTableConfig } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
import { kbBuilds, kbDocuments, kbOperations, kbVersions } from '../src/schema'
import { checksOf, foreignKeysOf, primaryColumns } from './schema-fixtures'

it('binds document active and desired pointers to the same owner, document and version', () => {
  expect(primaryColumns(kbDocuments)).toEqual(['owner_id', 'id'])
  expect(foreignKeysOf(kbDocuments)).toMatchObject({
    kb_documents_space_fk: {
      columns: ['owner_id', 'space_id'],
      target: 'kb_spaces',
      foreignColumns: ['owner_id', 'id'],
    },
    kb_documents_active_build_fk: {
      columns: ['owner_id', 'id', 'active_version_id', 'active_build_id'],
      target: 'kb_builds',
      foreignColumns: ['owner_id', 'document_id', 'version_id', 'id'],
    },
    kb_documents_desired_target_fk: {
      columns: ['owner_id', 'id', 'desired_version_id', 'desired_operation_id'],
      target: 'kb_operations',
      foreignColumns: ['owner_id', 'document_id', 'target_version_id', 'id'],
    },
  })
  expect(checksOf(kbDocuments).kb_documents_active_check).toMatch(
    /active_version_id.*IS NULL.*=.*active_build_id.*IS NULL/,
  )
  expect(checksOf(kbDocuments).kb_documents_desired_check).toMatch(
    /desired_version_id.*IS NULL.*desired_operation_id.*IS NOT NULL/,
  )
  expect(checksOf(kbDocuments).kb_documents_deleted_check).toMatch(
    /deleted_at.*IS NULL.*active_version_id.*IS NULL.*desired_operation_id.*IS NULL/,
  )
  expect(kbDocuments.activeVersionId.notNull).toBe(false)
  expect(kbDocuments.activeBuildId.notNull).toBe(false)
})

it('keeps verified originals, target operations and each generation/queue attempt inseparable', () => {
  expect(primaryColumns(kbVersions)).toEqual(['owner_id', 'document_id', 'id'])
  expect(foreignKeysOf(kbVersions).kb_versions_upload_fk).toMatchObject({
    columns: ['owner_id', 'document_id', 'upload_operation_id'],
    target: 'kb_operations',
    foreignColumns: ['owner_id', 'document_id', 'id'],
  })
  expect(foreignKeysOf(kbBuilds).kb_builds_operation_fk).toMatchObject({
    columns: ['owner_id', 'document_id', 'version_id', 'operation_id'],
    target: 'kb_operations',
    foreignColumns: ['owner_id', 'document_id', 'target_version_id', 'id'],
  })
  expect(
    getTableConfig(kbBuilds).uniqueConstraints.map((key) =>
      key.columns.map((column) => column.name),
    ),
  ).toContainEqual(['owner_id', 'operation_id', 'expected_generation', 'job_id', 'retry_count'])
  expect(checksOf(kbOperations).kb_operations_target_check).toMatch(
    /queued.*parsing.*indexing.*publishing.*ready.*target_version_id.*IS NOT NULL/,
  )
  expect(
    getTableConfig(kbOperations).indexes.find(
      (index) => index.config.name === 'kb_operations_live_unique',
    )?.config.unique,
  ).toBe(true)
  expect(getTableConfig(kbVersions).columns.map((column) => column.name)).not.toContain(
    'updated_at',
  )
  expect(getTableConfig(kbBuilds).columns.map((column) => column.name)).not.toContain(
    'active_tree_build_id',
  )
  for (const table of [kbDocuments, kbOperations, kbVersions, kbBuilds]) {
    for (const key of Object.values(foreignKeysOf(table))) {
      expect(key.onDelete).toBe('no action')
      expect(key.onUpdate).toBe('no action')
    }
  }
})
