import { afterAll, beforeAll, expect, it } from 'vitest'
import { changeBuild, closedBuildStates } from './build-fixtures'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('build-state')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

for (const assignment of [
  "owner_id = 'changed'",
  'id = gen_random_uuid()',
  'document_id = gen_random_uuid()',
  'version_id = gen_random_uuid()',
  'operation_id = gen_random_uuid()',
  'job_id = gen_random_uuid()',
  'retry_count = 1',
  'expected_generation = 1',
  'index_profile_id = gen_random_uuid()',
  "parser_revision = 'changed'",
  `parser_snapshot = '{"parser":"changed"}'`,
  'schema_version = 2',
  "created_at = created_at + interval '1 second'",
]) {
  it(`freezes Build.${assignment.split(' = ')[0]} before sealing`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      await expect(changeBuild(client, fixture, assignment)).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_immutable_facts',
      })
    })
  })
}

for (const assignment of [
  `manifest = '{"changed":true}'`,
  "manifest_hash = decode(repeat('cd', 32), 'hex')",
  'source_unit_count = 2',
  'chunk_count = 2',
  'embedding_count = 2',
  "sealed_at = sealed_at + interval '1 second'",
  'sealed_at = NULL',
]) {
  it(`freezes sealed Build.${assignment.split(' = ')[0]} even after invalidation`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      await changeBuild(client, fixture, closedBuildStates.sealed)
      await changeBuild(client, fixture, closedBuildStates.invalidated)
      await expect(changeBuild(client, fixture, assignment)).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_build_frozen',
      })
    })
  })
}

for (const [state, assignment] of Object.entries(closedBuildStates)) {
  it(`prevents a ${state} build from reopening its content gate`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      await changeBuild(client, fixture, assignment)
      await expect(
        changeBuild(
          client,
          fixture,
          `status = 'building', sealed_at = NULL,
        manifest = NULL, manifest_hash = NULL, gc_state = 'live', purged_at = NULL`,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_frozen' })
    })
  })

  it(`rejects direct deletion of a ${state} build`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      await changeBuild(client, fixture, assignment)
      await expect(
        client.query('DELETE FROM knowledge.kb_builds WHERE owner_id = $1 AND id = $2', [
          fixture.owners[0],
          fixture.id,
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_frozen' })
    })
  })
}

for (const state of ['invalidated', 'purged'] as const) {
  it(`prevents ${state} from being relabeled as sealed`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      await changeBuild(client, fixture, closedBuildStates[state])
      await expect(changeBuild(client, fixture, closedBuildStates.sealed)).rejects.toMatchObject({
        code: '23514',
        constraint: 'kb_build_frozen',
      })
    })
  })
}

it('rejects building count rewrites and permits the unchanged snapshot transitions', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    // B6 封存门：三项计数由封存协议按实况计算，building 行上的改写一律拒绝。
    await client.query('SAVEPOINT counts')
    await expect(
      changeBuild(client, fixture, 'source_unit_count = 1, chunk_count = 1, embedding_count = 1'),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_build_seal_gate' })
    await client.query('ROLLBACK TO SAVEPOINT counts')
    expect((await changeBuild(client, fixture, closedBuildStates.sealed)).rowCount).toBe(1)
    expect(
      (await changeBuild(client, fixture, 'manifest = manifest, sealed_at = sealed_at')).rowCount,
    ).toBe(1)
    expect(
      (await changeBuild(client, fixture, "status = 'invalidated', gc_state = 'pending'")).rowCount,
    ).toBe(1)
    expect((await changeBuild(client, fixture, closedBuildStates.purged)).rowCount).toBe(1)
  })
})

it('freezes a future Build fact column by default', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    await client.query('ALTER TABLE knowledge.kb_builds ADD COLUMN future_fact text')
    await expect(changeBuild(client, fixture, "future_fact = 'changed'")).rejects.toMatchObject({
      code: '23514',
      constraint: 'kb_immutable_facts',
    })
  })
})
