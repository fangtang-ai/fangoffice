import { randomUUID } from 'node:crypto'
import { capacityTransaction, withCapacityFixture, type CapacityFixture } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { inRoleTransaction } from './tenant-fixtures'

export const storageStart = Date.parse('2026-10-01T16:00:00.000Z')
export const storageDayMs = 86400000

export function storageWindow(day = 0) {
  return {
    windowId: randomUUID(),
    startAt: new Date(storageStart + day * storageDayMs),
    endAt: new Date(storageStart + (day + 1) * storageDayMs),
    tariffRevision: 'synthetic-storage-v1',
  }
}

export async function withStorageWindowFixture(work: (fixture: CapacityFixture) => Promise<void>) {
  await withCapacityFixture(async (fixture) => {
    await prepareStorageWindowFixture(fixture)
    await work(fixture)
  })
}

export async function prepareStorageWindowFixture(fixture: CapacityFixture) {
  await placeStorageHistory(fixture)
  const { pool } = await openLocalDatabase('bootstrap')
  try {
    await pool.query(
      'UPDATE knowledge.kb_quotas SET active_bytes = 4 WHERE owner_id = ANY($1::text[])',
      [fixture.owners],
    )
  } finally {
    await pool.end()
  }
}

export async function placeStorageHistory(fixture: CapacityFixture, offsetsMs = [0]) {
  const { pool } = await openLocalDatabase('bootstrap')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'ALTER TABLE knowledge.kb_metering_events DISABLE TRIGGER kb_immutable_facts',
    )
    for (const [index, offset] of offsetsMs.entries()) {
      await client.query(
        `UPDATE knowledge.kb_metering_events SET occurred_at = $2
          WHERE owner_id = ANY($1::text[]) AND event_type = 'capacity_change' AND sequence = $3`,
        [fixture.owners, new Date(storageStart + offset).toISOString(), index + 1],
      )
    }
    await client.query('ALTER TABLE knowledge.kb_metering_events ENABLE TRIGGER kb_immutable_facts')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export async function closeStorageSql(
  fixture: CapacityFixture,
  request: ReturnType<typeof storageWindow>,
  owner: string = fixture.owners[0],
) {
  return capacityTransaction(
    fixture,
    async (transaction) => {
      const { rows } = await transaction.query(
        'SELECT knowledge.close_storage_window($1, $2, $3, $4) AS status',
        [
          request.windowId,
          request.startAt.toISOString(),
          request.endAt.toISOString(),
          request.tariffRevision,
        ],
      )
      return (rows[0] as { status: string }).status
    },
    owner,
    'worker',
  )
}

export async function storageState(fixture: CapacityFixture, owner: string = fixture.owners[0]) {
  return inRoleTransaction(
    'api',
    owner,
    async (client) =>
      (
        await client.query(
          `SELECT id::text, window_id::text, quantity::text, opening_sequence::text AS opening,
              closing_sequence::text AS closing, encode(event_set_hash, 'hex') AS hash,
              tariff_revision, payer, delivery_state
         FROM knowledge.kb_metering_events
        WHERE owner_id = $1 AND subject_kind = 'storage_window' ORDER BY window_start`,
          [owner],
        )
      ).rows,
  )
}

export async function addStorageChanges(
  fixture: CapacityFixture,
  changes: { sequence: number; before: string; after: string; at: string }[],
) {
  const { pool } = await openLocalDatabase('bootstrap')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const change of changes) {
      const eventId = randomUUID()
      await client.query(
        `INSERT INTO knowledge.kb_metering_events
          (owner_id,id,logical_event_key,event_type,dimension,unit,quantity,usage_source,
           subject_kind,subject_key,sequence,active_bytes_before,active_bytes_after,payer,occurred_at)
         VALUES ($1,$2::uuid,$2::uuid::text,'capacity_change','storage','bytes',$3::bigint,
           'reconciled','capacity_change','synthetic',$4,$5,$3::bigint,'platform',$6)`,
        [fixture.owners[0], eventId, change.after, change.sequence, change.before, change.at],
      )
    }
    const latest = changes.at(-1)
    if (latest)
      await client.query('UPDATE knowledge.kb_quotas SET active_bytes = $2 WHERE owner_id = $1', [
        fixture.owners[0],
        latest.after,
      ])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}
