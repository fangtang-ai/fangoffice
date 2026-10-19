import { afterAll, beforeAll, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tenantTables } from './local-database'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('rls')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

it('makes a synthetic owner visible through actual API credentials', async () => {
  await inRoleTransaction('api', fixture.owners[0], async (client) => {
    const result = await client.query('SELECT owner_id FROM knowledge.kb_quotas')
    expect(result.rows).toEqual([{ owner_id: fixture.owners[0] }])
  })
})

for (const role of ['api', 'worker', 'gc', 'migrator'] as const) {
  for (const identity of ['a', 'b', 'missing', 'empty'] as const) {
    it(`${role} isolates all 15 populated tables for ${identity} identity, including FORCE on the owner`, async () => {
      const owner =
        identity === 'a'
          ? fixture.owners[0]
          : identity === 'b'
            ? fixture.owners[1]
            : identity === 'empty'
              ? ''
              : undefined
      await inRoleTransaction(role, owner, async (client) => {
        for (const table of tenantTables) {
          const result = await client.query<{ owner_id: string }>(
            `SELECT owner_id FROM knowledge.${table}`,
          )
          if (owner) {
            expect(result.rows.length, table).toBeGreaterThan(0)
            expect([...new Set(result.rows.map((row) => row.owner_id))], table).toEqual([owner])
          } else expect(result.rows, table).toEqual([])
        }
      })
    })
  }
}

for (const table of tenantTables) {
  it(`${table} rejects cross-owner mutations, owner reassignment and permissive-policy widening`, async () => {
    const row = await inRoleTransaction('bootstrap', undefined, async (client) => {
      const result = await client.query<{ sample: unknown }>(
        `SELECT to_jsonb(sample) AS sample FROM knowledge.${table} sample WHERE owner_id = $1 LIMIT 1`,
        [fixture.owners[1]],
      )
      expect(result.rowCount).toBe(1)
      return JSON.stringify(result.rows[0]?.sample)
    })
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      await client.query(`CREATE POLICY local_allow_all ON knowledge.${table}
        AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true)`)
      const visible = await client.query<{ owner_id: string }>(
        `SELECT owner_id FROM knowledge.${table}`,
      )
      expect([...new Set(visible.rows.map((entry) => entry.owner_id))]).toEqual([fixture.owners[0]])
      for (const statement of [
        `UPDATE knowledge.${table} SET owner_id = owner_id WHERE owner_id = $1`,
        `DELETE FROM knowledge.${table} WHERE owner_id = $1`,
      ])
        expect((await client.query(statement, [fixture.owners[1]])).rowCount).toBe(0)
      const ownerChangeError = [
        'kb_builds',
        'kb_versions',
        'kb_metering_events',
        'kb_billing_receipts',
      ].includes(table)
        ? { code: '23514', constraint: 'kb_immutable_facts' }
        : ['kb_source_units', 'kb_chunks', 'kb_chunk_sources', 'kb_chunk_embeddings'].includes(
              table,
            )
          ? { code: '23514', constraint: 'kb_build_content_immutable' }
          : { code: '42501' }
      const insertError = [
        'kb_source_units',
        'kb_chunks',
        'kb_chunk_sources',
        'kb_chunk_embeddings',
      ].includes(table)
        ? { code: '23514', constraint: 'kb_build_writable' }
        : table === 'kb_builds'
          ? // B5 取消/认领门在 RLS 之上先拦：跨 owner 视界内 operation 不可见，
            // 门按未知操作盲拒（23514），仍是“拒绝”——RLS 是最后防线。
            { code: '23514', constraint: 'kb_build_cancel_fence' }
          : { code: '42501' }
      for (const [statement, values, expectedError] of [
        [
          `INSERT INTO knowledge.${table} SELECT (jsonb_populate_record(NULL::knowledge.${table}, $1::jsonb)).*`,
          [row],
          insertError,
        ],
        [
          `UPDATE knowledge.${table} SET owner_id = $1 WHERE owner_id = $2`,
          [fixture.owners[1], fixture.owners[0]],
          ownerChangeError,
        ],
      ] as const) {
        await client.query('SAVEPOINT rejected_mutation')
        await expect(client.query(statement, [...values])).rejects.toMatchObject(expectedError)
        await client.query('ROLLBACK TO SAVEPOINT rejected_mutation')
      }
    })
  })
}

it('allows only same-owner API space metadata and refuses cross-owner or missing-identity inserts', async () => {
  await inRoleTransaction('api', fixture.owners[0], async (client) => {
    const inserted = await client.query(
      `INSERT INTO knowledge.kb_spaces (owner_id, id, title)
      VALUES ($1, $2, 'New synthetic space')`,
      [fixture.owners[0], randomUUID()],
    )
    expect(inserted.rowCount).toBe(1)
    expect(
      (
        await client.query(
          `UPDATE knowledge.kb_spaces SET title = 'Updated'
      WHERE owner_id = $1`,
          [fixture.owners[0]],
        )
      ).rowCount,
    ).toBe(2)
    expect(
      (
        await client.query(
          `UPDATE knowledge.kb_spaces SET title = 'Stolen'
      WHERE owner_id = $1`,
          [fixture.owners[1]],
        )
      ).rowCount,
    ).toBe(0)
  })
  for (const owner of [fixture.owners[0], undefined, '']) {
    await inRoleTransaction('api', owner, async (client) => {
      await expect(
        client.query(
          `INSERT INTO knowledge.kb_spaces (owner_id, id, title)
        VALUES ($1, $2, 'Forbidden')`,
          [fixture.owners[1], randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  }
})
