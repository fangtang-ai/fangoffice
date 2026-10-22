import { expect, it } from 'vitest'
import { closeStorageWindow } from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import {
  addStorageChanges,
  storageState,
  storageWindow,
  withStorageWindowFixture,
} from './storage-window-fixtures'

it('returns a contract-validated window and an exact GiB-day quotient with its remainder', async () => {
  await withStorageWindowFixture(async (fixture) => {
    const request = storageWindow()
    const close = () =>
      capacityTransaction(
        fixture,
        (transaction) => closeStorageWindow(transaction, request),
        fixture.owners[0],
        'worker',
      )
    await expect(close()).resolves.toMatchObject({
      replayed: false,
      event: {
        product: 'knowledge_base',
        dimension: 'storage',
        subject: { kind: 'storage_window', windowId: request.windowId, timezone: 'Asia/Shanghai' },
        usage: { source: 'reconciled', quantity: { unit: 'byte_ms', value: '345600000' } },
      },
      gibDays: {
        wholeDays: '0',
        remainderByteMs: '345600000',
        byteMsPerGiBDay: '92771293593600000',
      },
    })
    await expect(close()).resolves.toMatchObject({ replayed: true })
  })
})

it('preserves whole GiB-days and the exact sub-day remainder above the safe integer range', async () => {
  await withStorageWindowFixture(async (fixture) => {
    await addStorageChanges(fixture, [
      { sequence: 2, before: '4', after: '2147483651', at: '2026-10-01T16:00:00.000Z' },
    ])
    await expect(
      capacityTransaction(
        fixture,
        (transaction) => closeStorageWindow(transaction, storageWindow()),
        fixture.owners[0],
        'worker',
      ),
    ).resolves.toMatchObject({
      event: { usage: { quantity: { unit: 'byte_ms', value: '185542587446400000' } } },
      gibDays: {
        wholeDays: '2',
        remainderByteMs: '259200000',
        byteMsPerGiBDay: '92771293593600000',
      },
    })
  })
})

it('accepts alternate UUID casing without changing owner identity or replay semantics', async () => {
  await withStorageWindowFixture(async (fixture) => {
    const request = storageWindow()
    const close = (windowId: string) =>
      capacityTransaction(
        fixture,
        (transaction) => closeStorageWindow(transaction, { ...request, windowId }),
        fixture.owners[0],
        'worker',
      )
    await expect(close(request.windowId.toUpperCase())).resolves.toMatchObject({
      replayed: false,
      event: { id: request.windowId },
    })
    await expect(close(request.windowId)).resolves.toMatchObject({
      replayed: true,
      event: { id: request.windowId },
    })
    expect(await storageState(fixture)).toHaveLength(1)
  })
})

it('rolls back the window and its watermarks when later work in the trusted transaction fails', async () => {
  await withStorageWindowFixture(async (fixture) => {
    const request = storageWindow()
    await expect(
      capacityTransaction(
        fixture,
        async (transaction) => {
          await closeStorageWindow(transaction, request)
          await transaction.query('SELECT 1 / 0')
        },
        fixture.owners[0],
        'worker',
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await storageState(fixture)).toEqual([])
    await expect(
      capacityTransaction(
        fixture,
        (transaction) => closeStorageWindow(transaction, request),
        fixture.owners[0],
        'worker',
      ),
    ).resolves.toMatchObject({ replayed: false })
  })
})

it('maps SQL refusals without writing a storage observation', async () => {
  await withStorageWindowFixture(async (fixture) => {
    for (const [request, code] of [
      [storageWindow(1), 'VERSION_CONFLICT'],
      [storageWindow(10000), 'FORBIDDEN'],
      [{ ...storageWindow(), endAt: new Date('2026-10-02T15:59:59.999Z') }, 'INVALID_REQUEST'],
      [{ ...storageWindow(), tariffRevision: '' }, 'NOT_CONFIGURED'],
    ] as const) {
      await expect(
        capacityTransaction(
          fixture,
          (transaction) => closeStorageWindow(transaction, request),
          fixture.owners[0],
          'worker',
        ),
      ).rejects.toMatchObject({ code })
    }
    expect(await storageState(fixture)).toEqual([])
  })
})
