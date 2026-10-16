import { getTableConfig } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
import { kbEvidenceItems, kbEvidenceManifests, kbReservations } from '../src/schema'
import { checksOf, foreignKeysOf, primaryColumns } from './schema-fixtures'

it('binds each reservation and replacement credit to the same operation/document/base build', () => {
  expect(primaryColumns(kbReservations)).toEqual(['owner_id', 'operation_id'])
  expect(foreignKeysOf(kbReservations)).toMatchObject({
    kb_reservations_operation_fk: {
      columns: ['owner_id', 'document_id', 'operation_id'],
      target: 'kb_operations',
      foreignColumns: ['owner_id', 'document_id', 'id'],
    },
    kb_reservations_base_fk: {
      columns: ['owner_id', 'document_id', 'base_version_id', 'base_build_id'],
      target: 'kb_builds',
      foreignColumns: ['owner_id', 'document_id', 'version_id', 'id'],
    },
  })
  expect(checksOf(kbReservations).kb_reservations_base_check).toMatch(
    /base_version_id.*IS NULL.*=.*base_build_id.*IS NULL/,
  )
  expect(checksOf(kbReservations).kb_reservations_state_check).toMatch(/held.*applied.*released/)
  expect(
    getTableConfig(kbReservations).indexes.find(
      (index) => index.config.name === 'kb_reservations_held_idx',
    )?.config.where,
  ).toBeDefined()
})

it('retains minimal citation snapshots without strong foreign keys that block source GC', () => {
  expect(primaryColumns(kbEvidenceManifests)).toEqual(['owner_id', 'id'])
  expect(primaryColumns(kbEvidenceItems)).toEqual([
    'owner_id',
    'manifest_id',
    'citation_no',
    'span_no',
  ])
  expect(Object.values(foreignKeysOf(kbEvidenceItems))).toEqual([
    expect.objectContaining({
      columns: ['owner_id', 'manifest_id'],
      target: 'kb_evidence_manifests',
      foreignColumns: ['owner_id', 'id'],
    }),
  ])
  const columns = getTableConfig(kbEvidenceItems).columns.map((column) => column.name)
  expect(columns).toEqual(
    expect.arrayContaining([
      'document_id',
      'version_id',
      'build_id',
      'source_unit_id',
      'index_profile_id',
      'source_hash',
      'text_hash',
      'locator',
      'start_cp',
      'end_cp',
    ]),
  )
  expect(columns.join(' ')).not.toMatch(/excerpt|body|embedding|content|source_text/)
  expect(kbEvidenceItems.sourceUnitId.notNull).toBe(true)
  expect(checksOf(kbEvidenceManifests).kb_evidence_manifests_expiry_check).toMatch(
    /expires_at.*>.*created_at/,
  )
})
