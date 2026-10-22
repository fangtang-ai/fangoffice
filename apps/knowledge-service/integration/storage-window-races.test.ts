import { expect, it } from 'vitest'
import { closeStorageWindow } from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { prepareStorageWindowFixture, storageState, storageWindow } from './storage-window-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes window closure behind the quota holder and its %s',
  async (outcome) => {
    await withCapacityRace(
      async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
        await prepareStorageWindowFixture(fixture)
        const request = storageWindow()
        await expect(closeStorageWindow(writer, request)).resolves.toMatchObject({
          replayed: false,
        })
        const waiting = closeStorageWindow(waiter, request)
        await expectBlocked(observer, waiterPid, writerPid)
        await writer.query(outcome)
        await expect(waiting).resolves.toMatchObject({ replayed: outcome === 'COMMIT' })
        await waiter.query('COMMIT')
        expect(await storageState(fixture)).toHaveLength(1)
      },
      'worker',
      'worker',
    )
  },
)
