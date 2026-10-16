import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'
import {
  changeBuild,
  closedBuildStates,
  contentTables,
  prepareContentInsert,
} from './build-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('build-content')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

it('rejects a late source-unit INSERT into a sealed build', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    await client.query(
      `UPDATE knowledge.kb_builds SET status = 'sealed', sealed_at = now(),
      manifest = '{}', manifest_hash = decode(repeat('ab', 32), 'hex')
      WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await expect(
      client.query(
        `INSERT INTO knowledge.kb_source_units
      (owner_id, build_id, id, ordinal, type, text, text_hash, locator, coverage, warnings)
      VALUES ($1, $2, $3, 1, 'paragraph', 'Late synthetic text',
      decode(repeat('ab', 32), 'hex'), '{}', '{}', '[]')`,
        [fixture.owners[0], fixture.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_writable' })
  })
})

for (const table of contentTables) {
  it(`permits a valid ${table} INSERT into a building/live parent`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      const insert = await prepareContentInsert(client, fixture, table)
      expect((await client.query(insert.text, insert.values)).rowCount).toBe(1)
    })
  })

  for (const [state, assignment] of Object.entries(closedBuildStates)) {
    it(`rejects ${table} INSERT after its parent becomes ${state}`, async () => {
      await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
        const insert = await prepareContentInsert(client, fixture, table)
        await changeBuild(client, fixture, assignment)
        await expect(client.query(insert.text, insert.values)).rejects.toMatchObject({
          code: '23514',
          constraint: 'kb_build_writable',
        })
      })
    })
  }

  for (const state of ['building', 'sealed'] as const) {
    for (const operation of ['UPDATE', 'DELETE'] as const) {
      it(`rejects ${operation} of ${table} even with a ${state} parent`, async () => {
        await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
          if (state === 'sealed') await changeBuild(client, fixture, closedBuildStates.sealed)
          const sql =
            operation === 'UPDATE'
              ? `UPDATE knowledge.${table} SET owner_id = owner_id`
              : `DELETE FROM knowledge.${table}`
          await expect(
            client.query(`${sql} WHERE owner_id = $1 AND build_id = $2`, [
              fixture.owners[0],
              fixture.id,
            ]),
          ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_content_immutable' })
        })
      })
    }
  }

  it(`rejects ${table} INSERT whose parent is missing or belongs to the other tenant`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      const insert = await prepareContentInsert(client, fixture, table)
      for (const patch of [{ build_id: randomUUID() }, { owner_id: fixture.owners[1] }]) {
        await client.query('SAVEPOINT missing_parent')
        const changes = { ...(JSON.parse(insert.values[2]!) as Record<string, unknown>), ...patch }
        await expect(
          client.query(insert.text, [fixture.owners[0], fixture.id, JSON.stringify(changes)]),
        ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_writable' })
        await client.query('ROLLBACK TO SAVEPOINT missing_parent')
      }
    })
  })
}

it('rejects an UPSERT that attempts to mutate existing build content', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    await expect(
      client.query(
        `INSERT INTO knowledge.kb_source_units
      SELECT * FROM knowledge.kb_source_units WHERE owner_id = $1 AND build_id = $2
      ON CONFLICT (owner_id, build_id, id) DO UPDATE SET text = 'replacement'`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_content_immutable' })
  })
})

it('rolls back every row of a batch if a later row targets a closed build', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    const closedId = randomUUID()
    await client.query(
      `INSERT INTO knowledge.kb_builds SELECT
      (jsonb_populate_record(NULL::knowledge.kb_builds, to_jsonb(sample) || jsonb_build_object('id', $3::uuid, 'job_id', $3::uuid))).*
      FROM knowledge.kb_builds sample WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id, closedId],
    )
    await client.query(
      `UPDATE knowledge.kb_builds SET status = 'invalidated' WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], closedId],
    )
    await client.query('SAVEPOINT batch')
    await expect(
      client.query(
        `INSERT INTO knowledge.kb_source_units
      (owner_id, build_id, id, ordinal, type, text, text_hash, locator, coverage, warnings)
      SELECT $1, batch.build_id, gen_random_uuid(), 1, 'paragraph', 'Synthetic batch',
      decode(repeat('ab', 32), 'hex'), '{}', '{}', '[]'
      FROM (VALUES (1, $2::uuid), (2, $3::uuid)) batch(sequence, build_id) ORDER BY sequence`,
        [fixture.owners[0], fixture.id, closedId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_writable' })
    await client.query('ROLLBACK TO SAVEPOINT batch')
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM knowledge.kb_source_units
      WHERE owner_id = $1 AND build_id IN ($2, $3)`,
          [fixture.owners[0], fixture.id, closedId],
        )
      ).rows,
    ).toEqual([{ count: 1 }])
  })
})
