import { getTableConfig } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
import { kbIndexProfiles, kbQuotas, kbSpaces } from '../src/schema'
import { primaryColumns, schemaTables } from './schema-fixtures'

it('defines a platform profile and owner-scoped control tables without a second user or wallet', () => {
  for (const table of [kbIndexProfiles, kbQuotas, kbSpaces]) {
    expect(getTableConfig(table).schema).toBe('knowledge')
  }
  expect(primaryColumns(kbIndexProfiles)).toEqual(['id'])
  expect(primaryColumns(kbQuotas)).toEqual(['owner_id'])
  expect(primaryColumns(kbSpaces)).toEqual(['owner_id', 'id'])
  expect(kbQuotas.ownerId.getSQLType()).toBe('text')
  expect(kbIndexProfiles.configHash.getSQLType()).toBe('bytea')
  expect(kbQuotas.activeBytes.getSQLType()).toBe('bigint')
  expect(kbQuotas.activeBytes.mapFromDriverValue('9007199254740993')).toBe(9007199254740993n)
  expect(getTableConfig(kbIndexProfiles).columns.map((column) => column.name)).not.toContain(
    'owner_id',
  )
  expect(
    getTableConfig(kbQuotas)
      .columns.map((column) => column.name)
      .join(' '),
  ).not.toMatch(/balance|password|token|secret/)
  expect(
    getTableConfig(kbQuotas).foreignKeys.map((key) =>
      key.reference().foreignColumns.map((column) => column.name),
    ),
  ).toEqual([['id']])
  expect(
    getTableConfig(kbSpaces).foreignKeys.map((key) =>
      key.reference().foreignColumns.map((column) => column.name),
    ),
  ).toEqual([['owner_id']])
})

it('keeps exact bigint columns while using serializable SQL defaults for the generator', () => {
  for (const table of schemaTables) {
    for (const column of getTableConfig(table).columns) {
      expect(typeof column.default, `${getTableConfig(table).name}.${column.name}`).not.toBe(
        'bigint',
      )
    }
  }
})
