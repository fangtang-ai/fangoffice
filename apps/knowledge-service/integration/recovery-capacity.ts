import type { Pool } from 'pg'
import { expect } from 'vitest'
import type { BuildFixture } from './build-fixtures'
import { prepareReplacement } from './replacement-fixtures'
import { addFollowupUpload } from './retry-fixtures'

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
  await verifyRestoredCancellation(api, fixture, fixture.id, {
    generation: '1',
    physical: '16',
    activeBuild: null,
  })
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
  await verifyRestoredCancellation(api, fixture, replacement.replacementId, {
    generation: '2',
    physical: '32',
    activeBuild: fixture.id,
  })
  await api.query('ROLLBACK')
  await verifyRestoredRetry(bootstrap, api, fixture)
}

async function verifyRestoredRetry(bootstrap: Pool, api: Pool, fixture: BuildFixture) {
  const retryFixture = {
    ...fixture,
    owners: [fixture.owners[1], fixture.owners[0]] as const,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }
  const owner = retryFixture.owners[0]
  await bootstrap.query('DELETE FROM knowledge.kb_reservations WHERE owner_id = $1', [owner])
  await bootstrap.query(
    `UPDATE knowledge.kb_quotas SET policy_revision = 'synthetic', limit_files = 1,
      limit_bytes = 4, limit_chunks = 1 WHERE owner_id = $1`,
    [owner],
  )
  await api.query('BEGIN')
  await api.query("SELECT set_config('knowledge.owner_id', $1, true)", [owner])
  expect(
    (
      await api.query('SELECT knowledge.reserve_initial_capacity($1, 1, 16, $2) AS status', [
        fixture.id,
        retryFixture.expiresAt,
      ])
    ).rows,
  ).toEqual([{ status: 'RESERVED' }])
  expect(
    (await api.query('SELECT knowledge.cancel_capacity_reservation($1) AS status', [fixture.id]))
      .rows,
  ).toEqual([{ status: 'CANCELLED' }])
  await api.query('COMMIT')
  const operationId = await addFollowupUpload(retryFixture, { target: 'restore' })
  await api.query('BEGIN')
  await api.query("SELECT set_config('knowledge.owner_id', $1, true)", [owner])
  for (const status of ['RESERVED', 'REPLAY'])
    expect(
      (
        await api.query('SELECT knowledge.reserve_retry_capacity($1, 1, 16, $2) AS status', [
          operationId,
          retryFixture.expiresAt,
        ])
      ).rows,
    ).toEqual([{ status }])
  expect(
    (
      await api.query(
        `SELECT quota.reserved_files::text AS files,
      quota.reserved_bytes::text AS bytes, quota.reserved_chunks::text AS chunks,
      quota.physical_reserved_bytes::text AS physical, document.generation::text AS generation,
      document.desired_operation_id::text AS desired, reservation.projected_chunks::text AS projected
    FROM knowledge.kb_quotas quota
    JOIN knowledge.kb_documents document ON document.owner_id = quota.owner_id AND document.id = $2
    JOIN knowledge.kb_reservations reservation ON reservation.owner_id = quota.owner_id AND reservation.operation_id = $3
    WHERE quota.owner_id = $1`,
        [owner, fixture.id, operationId],
      )
    ).rows,
  ).toEqual([
    {
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '32',
      generation: '1',
      desired: operationId,
      projected: '1',
    },
  ])
  await verifyRestoredCancellation(api, retryFixture, operationId, {
    generation: '2',
    physical: '32',
    activeBuild: null,
  })
  await api.query('ROLLBACK')
}

async function verifyRestoredCancellation(
  api: Pool,
  fixture: { id: string; owners: readonly [string, ...string[]] },
  operationId: string,
  expected: { generation: string; physical: string; activeBuild: string | null },
) {
  for (const status of ['CANCELLED', 'REPLAY'])
    expect(
      (await api.query('SELECT knowledge.cancel_capacity_reservation($1) AS status', [operationId]))
        .rows,
    ).toEqual([{ status }])
  expect(
    (
      await api.query(
        `SELECT quota.reserved_files::text AS files,
    quota.reserved_bytes::text AS bytes, quota.reserved_chunks::text AS chunks,
    quota.physical_reserved_bytes::text AS physical, document.generation::text AS generation,
    document.active_build_id::text AS active_build, document.desired_operation_id AS desired,
    operation.phase, reservation.state
    FROM knowledge.kb_quotas quota
    JOIN knowledge.kb_documents document ON document.owner_id = quota.owner_id AND document.id = $2
    JOIN knowledge.kb_operations operation ON operation.owner_id = quota.owner_id AND operation.id = $3
    JOIN knowledge.kb_reservations reservation ON reservation.owner_id = quota.owner_id AND reservation.operation_id = operation.id
    WHERE quota.owner_id = $1`,
        [fixture.owners[0], fixture.id, operationId],
      )
    ).rows,
  ).toEqual([
    {
      files: '0',
      bytes: '0',
      chunks: '0',
      physical: expected.physical,
      generation: expected.generation,
      active_build: expected.activeBuild,
      desired: null,
      phase: 'cancelled',
      state: 'released',
    },
  ])
}
