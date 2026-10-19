import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { roleNames } from './local-database'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('worker-lock-security')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

it('denies direct worker phase updates that could lock Operation before Quota', async () => {
  await inRoleTransaction('worker', undefined, async (client) => {
    await expect(
      client.query('UPDATE knowledge.kb_operations SET phase = phase'),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

it.each(['manifest', 'source_unit_count', 'chunk_count', 'embedding_count', 'sealed_at', 'status'])(
  'denies direct worker Build %s writes',
  async (column) => {
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      await expect(
        client.query(`UPDATE knowledge.kb_builds SET ${column} = ${column}`),
      ).rejects.toMatchObject({ code: '42501' })
    })
  },
)

for (const role of ['api', 'gc'] as const) {
  for (const statement of [
    'SELECT knowledge.lock_build_lifecycle($1, $2, $2, $2)',
    "SELECT knowledge.seal_locked_build($1, $2, '{}', now())",
  ]) {
    it(`${role} cannot invoke ${statement}`, async () => {
      await inRoleTransaction(role, fixture.owners[0], async (client) => {
        await expect(
          client.query(statement, [fixture.owners[0], fixture.id]),
        ).rejects.toMatchObject({ code: '42501' })
      })
    })
  }
}

it('keeps lifecycle lock and seal definers owner-bound with no PUBLIC execution or table writes', async () => {
  await inRoleTransaction('bootstrap', undefined, async (client) => {
    const functions = await client.query(`SELECT proname, prosecdef AS definer, proconfig AS config,
      pg_get_userbyid(proowner) AS owner,
      EXISTS (SELECT 1 FROM aclexplode(proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc WHERE pronamespace = 'knowledge'::regnamespace
      AND proname IN ('lock_build_lifecycle', 'seal_locked_build') ORDER BY proname`)
    expect(functions.rows).toEqual(
      ['lock_build_lifecycle', 'seal_locked_build'].map((proname) => ({
        proname,
        definer: true,
        config: ['search_path=pg_catalog, pg_temp', 'row_security=on'],
        owner: 'knowledge_migrator',
        public_execute: false,
      })),
    )
    for (const role of Object.values(roleNames).filter((name) =>
      ['knowledge_api', 'knowledge_worker', 'knowledge_gc'].includes(name),
    )) {
      expect(
        (
          await client.query(
            `SELECT has_any_column_privilege($1, 'knowledge.kb_builds', 'UPDATE') AS builds,
            has_any_column_privilege($1, 'knowledge.kb_operations', 'UPDATE') AS operations`,
            [role],
          )
        ).rows,
      ).toEqual([{ builds: false, operations: false }])
    }
  })
})

it('refuses missing identity and cross-owner seals even when Build ids collide', async () => {
  for (const owner of [undefined, fixture.owners[0]]) {
    await inRoleTransaction('worker', owner, async (client) => {
      expect(
        (
          await client.query("SELECT knowledge.seal_locked_build($1, $2, '{}', now()) AS status", [
            fixture.owners[1],
            fixture.id,
          ])
        ).rows,
      ).toEqual([{ status: owner === undefined ? 'UNAUTHENTICATED' : 'NOT_FOUND' }])
    })
  }
  await inRoleTransaction('worker', fixture.owners[0], async (client) => {
    expect(
      (
        await client.query("SELECT knowledge.seal_locked_build($1, $2, '{}', now()) AS status", [
          fixture.owners[0],
          randomUUID(),
        ])
      ).rows,
    ).toEqual([{ status: 'NOT_FOUND' }])
  })
})

it.each(['null', '[]', '42', '"manifest"'])(
  'refuses an invalid controlled seal manifest %s',
  async (manifest) => {
    await inRoleTransaction('worker', fixture.owners[0], async (client) => {
      expect(
        (
          await client.query(
            'SELECT knowledge.seal_locked_build($1, $2, $3::jsonb, now()) AS status',
            [fixture.owners[0], fixture.id, manifest],
          )
        ).rows,
      ).toEqual([{ status: 'INVALID_REQUEST' }])
      expect(
        (
          await client.query(
            'SELECT status, manifest FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2',
            [fixture.owners[0], fixture.id],
          )
        ).rows,
      ).toEqual([{ status: 'building', manifest: null }])
    })
  },
)

it('does not accept a lock request for a different operation document or owner', async () => {
  await inRoleTransaction('worker', fixture.owners[0], async (client) => {
    for (const [owner, document] of [
      [fixture.owners[0], fixture.otherDocumentId],
      [fixture.owners[1], fixture.id],
    ]) {
      expect(
        (
          await client.query('SELECT knowledge.lock_build_lifecycle($1, $2, $3, $3) AS status', [
            owner,
            document,
            fixture.id,
          ])
        ).rows,
      ).toEqual([{ status: 'NOT_FOUND' }])
    }
  })
})
