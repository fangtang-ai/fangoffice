import { expect, it } from 'vitest'
import { inRoleTransaction } from './tenant-fixtures'
import {
  addStorageChanges,
  closeStorageSql,
  storageState,
  storageWindow,
  withStorageWindowFixture,
} from './storage-window-fixtures'

it('fails closed when a day exceeds the bounded capacity-change scan', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await inRoleTransaction('bootstrap', fixture.owners[0], async (client) => {
      await client.query(
        `INSERT INTO knowledge.kb_metering_events
          (owner_id,id,logical_event_key,event_type,dimension,unit,quantity,usage_source,
           subject_kind,subject_key,sequence,active_bytes_before,active_bytes_after,payer,occurred_at)
         SELECT $1, gen_random_uuid(), 'bounded:' || serial::text, 'capacity_change', 'storage', 'bytes',
                4, 'reconciled', 'capacity_change', 'synthetic', serial, 4, 4, 'platform',
                $2::timestamptz + serial * interval '1 millisecond'
           FROM generate_series(2, 10001) AS serial`,
        [fixture.owners[0], storageWindow().startAt.toISOString()],
      )
      await client.query('SET LOCAL ROLE knowledge_worker')
      const request = storageWindow()
      expect(
        (
          await client.query('SELECT knowledge.close_storage_window($1, $2, $3, $4) AS status', [
            request.windowId,
            request.startAt.toISOString(),
            request.endAt.toISOString(),
            request.tariffRevision,
          ])
        ).rows,
      ).toEqual([{ status: 'QUOTA_EXCEEDED' }])
    })
    expect(await storageState(fixture)).toEqual([])
  })
})

it('closes one Shanghai day into an exact immutable storage observation', async () => {
  await withStorageWindowFixture(async (fixture) => {
    const request = storageWindow()
    await expect(closeStorageSql(fixture, request)).resolves.toBe('CLOSED')
    expect(await storageState(fixture)).toEqual([
      {
        id: request.windowId,
        window_id: request.windowId,
        quantity: '345600000',
        opening: '0',
        closing: '1',
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        tariff_revision: 'synthetic-storage-v1',
        payer: 'customer',
        delivery_state: 'pending',
      },
    ])
  })
})

it('carries unchanged capacity through consecutive windows without rounding or rescanning files', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('CLOSED')
    await expect(closeStorageSql(fixture, storageWindow(1))).resolves.toBe('CLOSED')
    expect(await storageState(fixture)).toMatchObject([
      { quantity: '345600000', opening: '0', closing: '1' },
      { quantity: '345600000', opening: '1', closing: '1' },
    ])
    await expect(closeStorageSql(fixture, storageWindow(3))).resolves.toBe('VERSION_CONFLICT')
    expect(await storageState(fixture)).toHaveLength(2)
  })
})

it('replays a window exactly once and refuses a changed id or tariff', async () => {
  await withStorageWindowFixture(async (fixture) => {
    const request = storageWindow()
    expect(
      await Promise.all([closeStorageSql(fixture, request), closeStorageSql(fixture, request)]),
    ).toEqual(expect.arrayContaining(['CLOSED', 'REPLAY']))
    const before = await storageState(fixture)
    await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('VERSION_CONFLICT')
    await expect(closeStorageSql(fixture, { ...request, tariffRevision: 'changed' })).resolves.toBe(
      'VERSION_CONFLICT',
    )
    await expect(closeStorageSql(fixture, storageWindow(1))).resolves.toBe('CLOSED')
    await expect(closeStorageSql(fixture, request)).resolves.toBe('REPLAY')
    expect((await storageState(fixture))[0]).toEqual(before[0])
  })
})

it('orders same-millisecond replacements by sequence and stops storage at the tombstone change', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await addStorageChanges(fixture, [
      { sequence: 2, before: '4', after: '8', at: '2026-10-01T22:00:00.000Z' },
      { sequence: 3, before: '8', after: '16', at: '2026-10-01T22:00:00.000Z' },
      { sequence: 4, before: '16', after: '0', at: '2026-10-02T10:00:00.000Z' },
    ])
    await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('CLOSED')
    await expect(closeStorageSql(fixture, storageWindow(1))).resolves.toBe('CLOSED')
    expect(await storageState(fixture)).toMatchObject([
      { quantity: '777600000', opening: '0', closing: '4' },
      { quantity: '0', opening: '4', closing: '4' },
    ])
  })
})

it('assigns an exact boundary change only to the following half-open window', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await addStorageChanges(fixture, [
      { sequence: 2, before: '4', after: '8', at: '2026-10-02T16:00:00.000Z' },
    ])
    await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('CLOSED')
    await expect(closeStorageSql(fixture, storageWindow(1))).resolves.toBe('CLOSED')
    expect(await storageState(fixture)).toMatchObject([
      { quantity: '345600000', opening: '0', closing: '1' },
      { quantity: '691200000', opening: '1', closing: '2' },
    ])
  })
})

it('preserves byte-time above Number.MAX_SAFE_INTEGER', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await addStorageChanges(fixture, [
      { sequence: 2, before: '4', after: '1073741824', at: '2026-10-01T16:00:00.000Z' },
    ])
    await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('CLOSED')
    expect(await storageState(fixture)).toMatchObject([{ quantity: '92771293593600000' }])
  })
})

it('integrates sub-millisecond facts in deterministic integer millisecond buckets', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await addStorageChanges(fixture, [
      { sequence: 2, before: '4', after: '8', at: '2026-10-01T16:00:00.000999Z' },
      { sequence: 3, before: '8', after: '0', at: '2026-10-01T16:00:00.001001Z' },
    ])
    await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('CLOSED')
    expect(await storageState(fixture)).toMatchObject([{ quantity: '8' }])
  })
})

it.each(
  [
    [{ sequence: 3, before: '4', after: '0', at: '2026-10-02T04:00:00.000Z' }],
    [{ sequence: 2, before: '3', after: '0', at: '2026-10-02T04:00:00.000Z' }],
    [
      { sequence: 2, before: '4', after: '8', at: '2026-10-02T04:00:00.000Z' },
      { sequence: 3, before: '8', after: '0', at: '2026-10-02T03:00:00.000Z' },
    ],
  ].map((changes) => ({ changes })),
)('refuses a broken sequence, capacity or time chain: $changes', async ({ changes }) => {
  await withStorageWindowFixture(async (fixture) => {
    await addStorageChanges(fixture, changes)
    await expect(closeStorageSql(fixture, storageWindow())).resolves.toBe('VERSION_CONFLICT')
    expect(await storageState(fixture)).toEqual([])
  })
})

it('refuses late facts instead of changing a closed window or fabricating the next one', async () => {
  await withStorageWindowFixture(async (fixture) => {
    const request = storageWindow()
    await expect(closeStorageSql(fixture, request)).resolves.toBe('CLOSED')
    const before = await storageState(fixture)
    await addStorageChanges(fixture, [
      { sequence: 2, before: '4', after: '0', at: '2026-10-02T04:00:00.000Z' },
    ])
    await expect(closeStorageSql(fixture, request)).resolves.toBe('VERSION_CONFLICT')
    await expect(closeStorageSql(fixture, storageWindow(1))).resolves.toBe('VERSION_CONFLICT')
    expect(await storageState(fixture)).toEqual(before)
  })
})

it('does not skip the opening day, close a future day, or accept a partial-day range', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await expect(closeStorageSql(fixture, storageWindow(1))).resolves.toBe('VERSION_CONFLICT')
    await expect(closeStorageSql(fixture, storageWindow(10000))).resolves.toBe('FORBIDDEN')
    const request = storageWindow()
    await expect(
      closeStorageSql(fixture, { ...request, endAt: new Date(request.endAt.getTime() - 1) }),
    ).resolves.toBe('INVALID_REQUEST')
    await expect(closeStorageSql(fixture, { ...request, tariffRevision: '' })).resolves.toBe(
      'NOT_CONFIGURED',
    )
    expect(await storageState(fixture)).toEqual([])
  })
})
