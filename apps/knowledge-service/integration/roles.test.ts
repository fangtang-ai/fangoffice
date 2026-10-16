import { expect, it } from 'vitest'
import { roleNames, tenantTables } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

it('keeps runtime roles unprivileged, unrelated-database access denied and migration ownership separate', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    const roles = await client.query<{
      rolname: string
      unsafe: boolean
      memberships: string
      other_database: boolean
    }>(
      `
      SELECT rolname, (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) AS unsafe,
      (SELECT count(*)::text FROM pg_auth_members WHERE member = pg_roles.oid) AS memberships,
      has_database_privilege(rolname, 'postgres', 'CONNECT') AS other_database
      FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [[roleNames.api, roleNames.worker, roleNames.gc, roleNames.migrator]],
    )
    expect(roles.rowCount).toBe(4)
    for (const role of roles.rows) {
      expect(role.unsafe, role.rolname).toBe(false)
      expect(role.memberships, role.rolname).toBe('0')
      expect(role.other_database, role.rolname).toBe(false)
    }
  })
})

for (const role of ['api', 'worker', 'gc'] as const) {
  it(`${role} has only explicit reads and the narrow API space metadata grants`, async () => {
    await inRoleTransaction(role, undefined, async (client) => {
      for (const table of [...tenantTables, 'kb_index_profiles']) {
        const result = await client.query<{
          read: boolean
          insert: boolean
          update: boolean
          delete: boolean
          truncate: boolean
          trigger: boolean
        }>(
          `
          SELECT has_table_privilege(current_user, $1, 'SELECT') AS read,
          has_table_privilege(current_user, $1, 'INSERT') AS insert,
          has_table_privilege(current_user, $1, 'UPDATE') AS update,
          has_table_privilege(current_user, $1, 'DELETE') AS delete,
          has_table_privilege(current_user, $1, 'TRUNCATE') AS truncate,
          has_table_privilege(current_user, $1, 'TRIGGER') AS trigger`,
          [`knowledge.${table}`],
        )
        expect(result.rows).toEqual([
          {
            read: true,
            insert: false,
            update: false,
            delete: false,
            truncate: false,
            trigger: false,
          },
        ])
      }
      const columns = await client.query<{
        metadata: boolean
        owner: boolean
        lifecycle: boolean
      }>(`
        SELECT has_column_privilege(current_user, 'knowledge.kb_spaces', 'title', 'UPDATE') AS metadata,
        has_column_privilege(current_user, 'knowledge.kb_spaces', 'owner_id', 'UPDATE') AS owner,
        has_column_privilege(current_user, 'knowledge.kb_spaces', 'state', 'UPDATE') AS lifecycle`)
      expect(columns.rows).toEqual([{ metadata: role === 'api', owner: false, lifecycle: false }])
    })
  })

  for (const statement of [
    'CREATE SCHEMA unauthorized',
    'CREATE TABLE knowledge.unauthorized (id integer)',
    'CREATE TABLE public.unauthorized (id integer)',
    'CREATE TEMP TABLE unauthorized (id integer)',
    'ALTER TABLE knowledge.kb_spaces DISABLE ROW LEVEL SECURITY',
    'ALTER TABLE knowledge.kb_spaces DISABLE TRIGGER ALL',
    'TRUNCATE knowledge.kb_spaces CASCADE',
    'SET ROLE knowledge_migrator',
    'SET ROLE knowledge_bootstrap',
    'SET SESSION AUTHORIZATION knowledge_bootstrap',
    'ALTER ROLE CURRENT_USER BYPASSRLS',
    'UPDATE knowledge.kb_index_profiles SET config = config',
    'DELETE FROM knowledge.kb_versions',
    'UPDATE knowledge.kb_metering_events SET quantity = 0',
    'UPDATE knowledge.kb_billing_receipts SET settlement_snapshot = settlement_snapshot',
  ]) {
    it(`${role} rejects ${statement}`, async () => {
      await inRoleTransaction(role, undefined, async (client) => {
        await expect(client.query(statement)).rejects.toMatchObject({ code: '42501' })
      })
    })
  }
}

// B7 后 worker 持有 kb_documents 发布三列的列级 UPDATE；清空指针的授权面
// 只有 api/gc 仍停留在特权拒绝（worker 的指针变更由发布门约束，见
// build-security.test.ts）。
for (const role of ['api', 'gc'] as const) {
  it(`${role} rejects UPDATE knowledge.kb_documents SET active_build_id = NULL`, async () => {
    await inRoleTransaction(role, undefined, async (client) => {
      await expect(
        client.query('UPDATE knowledge.kb_documents SET active_build_id = NULL'),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
}
