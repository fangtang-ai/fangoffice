import { is } from 'drizzle-orm'
import { PgDialect, getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from '../src/schema'

export const schemaTables = Object.values(schema).filter((entry) => is(entry, PgTable))

export function primaryColumns(table: PgTable) {
  const config = getTableConfig(table)
  return [
    ...config.columns.filter((column) => column.primary),
    ...config.primaryKeys.flatMap((key) => key.columns),
  ].map((column) => column.name)
}

export function foreignKeysOf(table: PgTable) {
  return Object.fromEntries(
    getTableConfig(table).foreignKeys.map((key) => {
      const reference = key.reference()
      return [
        key.getName(),
        {
          columns: reference.columns.map((column) => column.name),
          target: getTableConfig(reference.foreignTable).name,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: key.onDelete,
          onUpdate: key.onUpdate,
        },
      ]
    }),
  )
}

export function checksOf(table: PgTable) {
  const dialect = new PgDialect()
  return Object.fromEntries(
    getTableConfig(table).checks.map((constraint) => [
      constraint.name,
      dialect.sqlToQuery(constraint.value).sql.replace(/\s+/g, ' ').trim(),
    ]),
  )
}
