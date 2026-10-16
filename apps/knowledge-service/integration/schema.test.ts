import { expect, it } from 'vitest'
import { openLocalDatabase, tenantTables } from './local-database'

it('applies exactly 16 tables with FORCE and both policies on all 15 tenant tables', async () => {
  const { pool } = await openLocalDatabase('bootstrap')
  try {
    const tables = await pool.query<{ name: string; rls: boolean; force: boolean; owner: string }>(`
      SELECT relname AS name, relrowsecurity AS rls, relforcerowsecurity AS force,
      pg_get_userbyid(relowner) AS owner FROM pg_class
      WHERE relnamespace = to_regnamespace('knowledge') AND relkind = 'r' ORDER BY relname`)
    expect(tables.rows.map((row) => row.name)).toEqual(
      [...tenantTables, 'kb_index_profiles'].sort(),
    )
    for (const table of tables.rows) {
      expect(table.owner).toBe('knowledge_migrator')
      expect(table.rls).toBe(table.name !== 'kb_index_profiles')
      expect(table.force).toBe(table.name !== 'kb_index_profiles')
    }
    const policies = await pool.query<{
      tablename: string
      policyname: string
      permissive: string
      cmd: string
      roles: string[]
    }>(`
      SELECT tablename, policyname, permissive, cmd, roles::text[] AS roles FROM pg_policies
      WHERE schemaname = 'knowledge' ORDER BY tablename, policyname`)
    expect(policies.rowCount).toBe(30)
    for (const table of tenantTables) {
      expect(policies.rows.filter((row) => row.tablename === table)).toEqual([
        {
          tablename: table,
          policyname: 'owner_access',
          permissive: 'PERMISSIVE',
          cmd: 'ALL',
          roles: ['public'],
        },
        {
          tablename: table,
          policyname: 'owner_guard',
          permissive: 'RESTRICTIVE',
          cmd: 'ALL',
          roles: ['public'],
        },
      ])
    }
    const vector = await pool.query<{ type: string }>(`
      SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
      WHERE attrelid = 'knowledge.kb_chunk_embeddings'::regclass AND attname = 'embedding'`)
    expect(vector.rows[0]?.type).toBe('extensions.vector(1024)')
  } finally {
    await pool.end()
  }
})
