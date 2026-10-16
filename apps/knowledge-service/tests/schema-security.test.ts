import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { kbIndexProfiles } from '../src/schema'
import { schemaTables } from './schema-fixtures'

it('requires the same owner for reading and writing on every tenant table, without granting SQL privileges', () => {
  const dialect = new PgDialect()
  for (const table of schemaTables.filter((entry) => entry !== kbIndexProfiles)) {
    const config = getTableConfig(table)
    expect(config.enableRLS, config.name).toBe(true)
    expect(
      config.policies.map((policy) => [policy.name, policy.as, policy.for, policy.to]),
    ).toEqual([
      ['owner_access', 'permissive', 'all', 'public'],
      ['owner_guard', 'restrictive', 'all', 'public'],
    ])
    for (const policy of config.policies) {
      expect(policy.using).toBeDefined()
      expect(policy.withCheck).toBeDefined()
      const using = dialect.sqlToQuery(policy.using!).sql
      expect(using).toBe(dialect.sqlToQuery(policy.withCheck!).sql)
      expect(using).toContain('owner_id')
      expect(using).toContain("NULLIF(current_setting('knowledge.owner_id', true), '')")
      expect(using).toMatch(/SELECT.*current_setting/)
      expect(using).not.toMatch(/OR|coalesce|current_user|session_user/i)
    }
  }
  expect(getTableConfig(kbIndexProfiles).policies).toEqual([])
  expect(getTableConfig(kbIndexProfiles).enableRLS).toBe(false)
})

it('provides an explicit FORCE review supplement for exactly the tenant tables, without role provisioning', async () => {
  const source = await readFile(new URL('../security/force-rls.sql', import.meta.url), 'utf8')
  const statements = source
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
  expect(statements.sort()).toEqual(
    schemaTables
      .filter((table) => table !== kbIndexProfiles)
      .map(
        (table) =>
          `ALTER TABLE "knowledge"."${getTableConfig(table).name}" FORCE ROW LEVEL SECURITY`,
      )
      .sort(),
  )
  expect(new Set(statements).size).toBe(15)
})
