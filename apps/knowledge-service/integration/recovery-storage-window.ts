import { expect } from 'vitest'
import {
  closeStorageWindow,
  createKnowledgeReplayPrincipal,
  withKnowledgeTransaction,
} from '../src/runtime'
import { capacityTransaction } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'
import { prepareStorageWindowFixture, storageWindow } from './storage-window-fixtures'
import { removeTenants, seedTenants } from './tenant-fixtures'

export async function prepareStorageWindowRecovery() {
  const seeded = await seedTenants('storage-recovery')
  const fixture = { ...seeded, expiresAt: new Date(Date.now() + 60000).toISOString() }
  try {
    await prepareStorageWindowFixture(fixture)
    const request = storageWindow()
    const result = await capacityTransaction(
      fixture,
      (transaction) => closeStorageWindow(transaction, request),
      fixture.owners[0],
      'worker',
    )
    return { fixture, request, event: result.event }
  } catch (error) {
    await removeTenants(fixture)
    throw error
  }
}

export async function verifyRestoredStorageWindow(
  storage: Awaited<ReturnType<typeof prepareStorageWindowRecovery>>,
) {
  const { pool } = await openLocalDatabase('worker', 'restore')
  const owner = storage.fixture.owners[0]
  const principal = createKnowledgeReplayPrincipal(owner, {
    issuer: 'https://synthetic.invalid',
    audience: 'local-knowledge',
  })
  try {
    await expect(
      withKnowledgeTransaction(pool, principal, (transaction) =>
        closeStorageWindow(transaction, storage.request),
      ),
    ).resolves.toMatchObject({ replayed: true, event: storage.event })
    await expect(
      withKnowledgeTransaction(pool, principal, (transaction) =>
        closeStorageWindow(transaction, storageWindow(1)),
      ),
    ).resolves.toMatchObject({
      replayed: false,
      event: {
        subject: { openingSequence: '1', closingSequence: '1' },
        usage: { quantity: { value: '345600000' } },
      },
    })
    await withKnowledgeTransaction(pool, principal, async (transaction) => {
      expect(
        (
          await transaction.query(
            "SELECT count(*)::text AS windows FROM knowledge.kb_metering_events WHERE subject_kind = 'storage_window'",
          )
        ).rows,
      ).toEqual([{ windows: '2' }])
    })
  } finally {
    await pool.end()
  }
}
