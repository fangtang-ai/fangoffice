import { sql } from 'drizzle-orm'
import { bigint, check, customType, pgSchema, timestamp, type PgColumn } from 'drizzle-orm/pg-core'

export const knowledge = pgSchema('knowledge')
export const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })
export const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })
export const counter = (name: string) => bigint(name, { mode: 'bigint' })
export const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })
export const timestamps = () => ({
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
})
export const nonnegative = (name: string, ...columns: PgColumn[]) =>
  check(
    name,
    sql.join(
      columns.map((column) => sql`${column} >= 0`),
      sql` AND `,
    ),
  )
export const hashCheck = (name: string, column: PgColumn) =>
  check(name, sql`octet_length(${column}) = 32`)
