import type { Pool } from 'pg'
import { expect } from 'vitest'
import type { BuildFixture } from './build-fixtures'
import { prepareReplacement } from './replacement-fixtures'

export async function verifyRestoredCapacity(bootstrap: Pool, api: Pool, fixture: BuildFixture) {
  await bootstrap.query('BEGIN')
  await bootstrap.query('DELETE FROM knowledge.kb_reservations WHERE owner_id = $1', [
    fixture.owners[0],
  ])
  await bootstrap.query(
    `UPDATE knowledge.kb_quotas
     SET policy_revision = 'synthetic', limit_files = 1, limit_bytes = 4, limit_chunks = 1
     WHERE owner_id = $1`,
    [fixture.owners[0]],
  )
  await bootstrap.query('COMMIT')
  await api.query('BEGIN')
  await api.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
  expect(
    (
      await api.query(
        "SELECT knowledge.reserve_initial_capacity($1, 1, 16, now() + interval '1 hour') AS status",
        [fixture.id],
      )
    ).rows,
  ).toEqual([{ status: 'RESERVED' }])
  expect(
    (
      await api.query(
        `SELECT reserved_files::text AS files, reserved_bytes::text AS bytes,
            reserved_chunks::text AS chunks, physical_reserved_bytes::text AS physical
     FROM knowledge.kb_quotas`,
      )
    ).rows,
  ).toEqual([{ files: '1', bytes: '4', chunks: '1', physical: '16' }])
  await api.query('ROLLBACK')

  const replacement = await prepareReplacement(
    { ...fixture, expiresAt: new Date(Date.now() + 3600000).toISOString() },
    { target: 'restore' },
  )
  await api.query('BEGIN')
  await api.query("SELECT set_config('knowledge.owner_id', $1, true)", [fixture.owners[0]])
  expect(
    (
      await api.query('SELECT knowledge.reserve_replacement_capacity($1, 3, 32, $2) AS status', [
        replacement.replacementId,
        replacement.expiresAt,
      ])
    ).rows,
  ).toEqual([{ status: 'RESERVED' }])
  expect(
    (
      await api.query(
        `SELECT reserved_bytes::text AS bytes, reserved_chunks::text AS chunks,
            projected_chunks::text AS projected, base_build_id::text AS base
     FROM knowledge.kb_reservations WHERE owner_id = $1`,
        [fixture.owners[0]],
      )
    ).rows,
  ).toEqual([{ bytes: '2', chunks: '2', projected: '3', base: fixture.id }])
  await api.query('ROLLBACK')
}
