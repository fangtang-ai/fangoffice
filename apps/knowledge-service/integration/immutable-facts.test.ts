import { afterAll, beforeAll, expect, it } from 'vitest'
import { inRoleTransaction, removeTenants, seedTenants } from './tenant-fixtures'

let fixture: Awaited<ReturnType<typeof seedTenants>>
beforeAll(async () => {
  fixture = await seedTenants('immutable')
})
afterAll(async () => {
  if (fixture) await removeTenants(fixture)
})

const changes = {
  kb_index_profiles: [
    'id = gen_random_uuid()',
    "config_hash = decode(repeat('cd', 32), 'hex')",
    "provider = 'changed'",
    "region = 'changed'",
    "model = 'changed'",
    "model_revision = 'changed'",
    'dimension = 1536',
    "distance = 'l2'",
    "normalization = 'changed'",
    `pipeline_revisions = '{"parser":"changed"}'`,
    `config = '{"model":"changed"}'`,
    'schema_version = 2',
    "created_at = created_at + interval '1 second'",
  ],
  kb_versions: [
    "owner_id = 'changed'",
    'document_id = gen_random_uuid()',
    'id = gen_random_uuid()',
    'version_no = 2',
    'upload_operation_id = gen_random_uuid()',
    "bucket = 'changed'",
    "oss_key = 'tampered-original'",
    "file_hash = decode(repeat('cd', 32), 'hex')",
    'size_bytes = 5',
    "format = 'md'",
    "mime = 'text/markdown'",
    "verified_at = verified_at + interval '1 second'",
    "created_at = created_at + interval '1 second'",
  ],
  kb_metering_events: [
    "owner_id = 'changed'",
    'id = gen_random_uuid()',
    "logical_event_key = 'changed'",
    "event_type = 'observation'",
    'supersedes_event_id = gen_random_uuid()',
    "dimension = 'embedding'",
    "unit = 'tokens'",
    'quantity = 5',
    "usage_source = 'estimated'",
    "subject_kind = 'changed'",
    "subject_key = 'changed'",
    'document_id = gen_random_uuid()',
    'version_id = gen_random_uuid()',
    'operation_id = gen_random_uuid()',
    'build_id = gen_random_uuid()',
    'run_id = gen_random_uuid()',
    'call_id = gen_random_uuid()',
    'attempt_id = gen_random_uuid()',
    'index_profile_id = gen_random_uuid()',
    "purpose = 'changed'",
    "call_state = 'changed'",
    "completion = 'changed'",
    'sequence = 2',
    'active_bytes_before = 1',
    'active_bytes_after = 5',
    'window_id = gen_random_uuid()',
    'window_start = now()',
    'window_end = now()',
    'opening_sequence = 1',
    'closing_sequence = 2',
    "event_set_hash = decode(repeat('cd', 32), 'hex')",
    "tariff_revision = 'changed'",
    "payer = 'customer'",
    'schema_version = 2',
    "occurred_at = occurred_at + interval '1 second'",
    "created_at = created_at + interval '1 second'",
  ],
  kb_billing_receipts: [
    "owner_id = 'changed'",
    'id = gen_random_uuid()',
    "settlement_key = 'changed'",
    "product = 'changed'",
    "dimension = 'embedding'",
    "tariff_revision = 'changed'",
    `settlement_snapshot = '{"quantity":"5"}'`,
    "snapshot_hash = decode(repeat('cd', 32), 'hex')",
    'schema_version = 2',
    "created_at = created_at + interval '1 second'",
  ],
} as const

for (const [table, assignments] of Object.entries(changes)) {
  for (const assignment of assignments) {
    it(`rejects ${table}.${assignment.split(' = ')[0]} replacement before other constraints`, async () => {
      await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
        const profile = table === 'kb_index_profiles'
        await expect(
          client.query(
            `UPDATE knowledge.${table} SET ${assignment} WHERE id = $1${profile ? '' : ' AND owner_id = $2'}`,
            profile ? [fixture.profileId] : [fixture.id, fixture.owners[0]],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
      })
    })
  }

  it(`rejects ${table} deletion without relying on a referencing row`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      const profile = table === 'kb_index_profiles'
      await expect(
        client.query(
          `DELETE FROM knowledge.${table} WHERE id = $1${profile ? '' : ' AND owner_id = $2'}`,
          profile ? [fixture.profileId] : [fixture.id, fixture.owners[0]],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
    })
  })

  it(`permits unchanged ${table} facts, including nulls and binary hashes`, async () => {
    await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
      const profile = table === 'kb_index_profiles'
      const result = await client.query(
        `UPDATE knowledge.${table} SET id = id WHERE id = $1${profile ? '' : ' AND owner_id = $2'}`,
        profile ? [fixture.profileId] : [fixture.id, fixture.owners[0]],
      )
      expect(result.rowCount).toBe(1)
    })
  })
}

it('permits only version retention/GC fields without rewriting original facts', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    const result = await client.query(
      `UPDATE knowledge.kb_versions
      SET retain_until = now() + interval '1 day', gc_state = 'purged', purged_at = now()
      WHERE owner_id = $1 AND id = $2 RETURNING oss_key, gc_state, retain_until IS NOT NULL AS retained`,
      [fixture.owners[0], fixture.id],
    )
    expect(result.rows).toEqual([
      { oss_key: `${fixture.owners[0]}/sample.txt`, gc_state: 'purged', retained: true },
    ])
  })
})

it('permits metering delivery fields while preserving recorded quantity', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    const result = await client.query(
      `UPDATE knowledge.kb_metering_events
      SET delivery_state = 'delivered', delivery_attempts = 1,
      next_attempt_at = now() + interval '1 minute', delivered_at = now()
      WHERE owner_id = $1 AND id = $2 RETURNING quantity, delivery_state, delivery_attempts`,
      [fixture.owners[0], fixture.id],
    )
    expect(result.rows).toEqual([
      { quantity: '4', delivery_state: 'delivered', delivery_attempts: 1 },
    ])
  })
})

it('permits receipt reconciliation fields while preserving the frozen settlement request', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    const result = await client.query(
      `UPDATE knowledge.kb_billing_receipts
      SET status = 'reserved', site_receipt_id = $2, confirmed_at = now(),
      site_amounts = '{"reserved":"1"}', reconciled_at = now(),
      next_reconcile_at = now() + interval '1 minute', updated_at = now()
      WHERE owner_id = $1 AND id = $2 RETURNING status, settlement_snapshot, site_amounts`,
      [fixture.owners[0], fixture.id],
    )
    expect(result.rows).toEqual([
      { status: 'reserved', settlement_snapshot: {}, site_amounts: { reserved: '1' } },
    ])
  })
})

it('rejects a mixed fact/delivery update and atomically restores earlier delivery changes', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    await client.query('SAVEPOINT delivery')
    await client.query(
      `UPDATE knowledge.kb_metering_events SET delivery_attempts = 1
      WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    await expect(
      client.query(
        `UPDATE knowledge.kb_metering_events SET quantity = 5, delivery_attempts = 2
      WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
    await client.query('ROLLBACK TO SAVEPOINT delivery')
    const result = await client.query(
      `SELECT quantity, delivery_attempts FROM knowledge.kb_metering_events
      WHERE owner_id = $1 AND id = $2`,
      [fixture.owners[0], fixture.id],
    )
    expect(result.rows).toEqual([{ quantity: '4', delivery_attempts: 0 }])
  })
})

it('protects a newly added fact column without changing the trigger allowlist', async () => {
  await inRoleTransaction('migrator', fixture.owners[0], async (client) => {
    await client.query('ALTER TABLE knowledge.kb_versions ADD COLUMN future_fact text')
    await expect(
      client.query(
        `UPDATE knowledge.kb_versions SET future_fact = 'changed'
      WHERE owner_id = $1 AND id = $2`,
        [fixture.owners[0], fixture.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'kb_immutable_facts' })
  })
})
