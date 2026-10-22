import { expect } from 'vitest'
import { openLocalDatabase } from './local-database'
import { seedTenants } from './tenant-fixtures'

export async function verifyRestoredPublication() {
  const fixture = await seedTenants('publication-restore', 'restore')
  const { pool: bootstrap } = await openLocalDatabase('bootstrap', 'restore')
  const { pool: api } = await openLocalDatabase('api', 'restore')
  const { pool: worker } = await openLocalDatabase('worker', 'restore')
  const setup = await bootstrap.connect()
  const admission = await api.connect()
  const publisher = await worker.connect()
  try {
    await setup.query('BEGIN')
    await setup.query('DELETE FROM knowledge.kb_reservations WHERE owner_id = $1', [
      fixture.owners[0],
    ])
    await setup.query(
      `UPDATE knowledge.kb_quotas SET policy_revision = 'synthetic',
      limit_files = 1, limit_bytes = 4, limit_chunks = 1 WHERE owner_id = $1`,
      [fixture.owners[0]],
    )
    await setup.query('ALTER TABLE knowledge.kb_metering_events DISABLE TRIGGER kb_immutable_facts')
    await setup.query('DELETE FROM knowledge.kb_metering_events WHERE owner_id = $1', [
      fixture.owners[0],
    ])
    await setup.query('ALTER TABLE knowledge.kb_metering_events ENABLE TRIGGER kb_immutable_facts')
    await setup.query('COMMIT')
    await admission.query('BEGIN')
    await admission.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
    expect(
      (
        await admission.query(
          `SELECT knowledge.reserve_initial_capacity($1, 1, 16,
      now() + interval '1 hour') AS status`,
          [fixture.id],
        )
      ).rows,
    ).toEqual([{ status: 'RESERVED' }])
    await admission.query('COMMIT')
    await publisher.query('BEGIN')
    await publisher.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
    expect(
      (
        await publisher.query(
          'SELECT knowledge.bind_operation_attempt($1, $2, $2, $2, 0, $2) AS status',
          [fixture.owners[0], fixture.id],
        )
      ).rows,
    ).toEqual([{ status: 'BOUND' }])
    expect(
      (
        await publisher.query("SELECT knowledge.seal_locked_build($1, $2, '{}', now()) AS status", [
          fixture.owners[0],
          fixture.id,
        ])
      ).rows,
    ).toEqual([{ status: 'SEALED' }])
    for (const status of ['PUBLISHED', 'REPLAY'])
      expect(
        (
          await publisher.query(
            'SELECT knowledge.publish_reserved_build($1, $2, $2, $2, $2, $3) AS status',
            [fixture.owners[0], fixture.id, fixture.profileId],
          )
        ).rows,
      ).toEqual([{ status }])
    expect(
      (
        await publisher.query(
          `SELECT quota.active_bytes::text AS bytes,
      quota.reserved_bytes::text AS reserved, quota.physical_accounted_bytes::text AS physical,
      document.generation::text AS generation, document.desired_operation_id AS desired,
      (SELECT count(*)::int FROM knowledge.kb_metering_events WHERE owner_id = $1) AS events
      FROM knowledge.kb_quotas quota JOIN knowledge.kb_documents document
      ON document.owner_id = quota.owner_id AND document.id = $2 WHERE quota.owner_id = $1`,
          [fixture.owners[0], fixture.id],
        )
      ).rows,
    ).toEqual([
      {
        bytes: '4',
        reserved: '0',
        physical: '16',
        generation: '1',
        desired: null,
        events: 1,
      },
    ])
    await publisher.query('SAVEPOINT direct_write')
    await expect(
      publisher.query('UPDATE knowledge.kb_documents SET active_build_id = active_build_id'),
    ).rejects.toMatchObject({ code: '42501' })
    await publisher.query('ROLLBACK TO SAVEPOINT direct_write')
    for (const statement of [
      "UPDATE knowledge.kb_builds SET status = 'sealed'",
      'UPDATE knowledge.kb_operations SET phase = phase',
    ]) {
      await publisher.query('SAVEPOINT lifecycle_bypass')
      await expect(publisher.query(statement)).rejects.toMatchObject({ code: '42501' })
      await publisher.query('ROLLBACK TO SAVEPOINT lifecycle_bypass')
    }
    await publisher.query('COMMIT')
  } finally {
    await Promise.allSettled(
      [setup, admission, publisher].map((client) => client.query('ROLLBACK')),
    )
    for (const client of [setup, admission, publisher]) client.release()
    await Promise.all([bootstrap, api, worker].map((pool) => pool.end()))
  }
}
