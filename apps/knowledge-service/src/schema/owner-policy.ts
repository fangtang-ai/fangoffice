import { sql } from 'drizzle-orm'
import { pgPolicy, type PgColumn } from 'drizzle-orm/pg-core'

export function ownerPolicies(owner: PgColumn) {
  const predicate = sql`${owner} = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))`
  // The restrictive guard also constrains any future permissive policy; SQL grants remain separate.
  return [
    pgPolicy('owner_access', {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: predicate,
      withCheck: predicate,
    }),
    pgPolicy('owner_guard', {
      as: 'restrictive',
      for: 'all',
      to: 'public',
      using: predicate,
      withCheck: predicate,
    }),
  ]
}
