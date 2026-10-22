import { randomUUID } from 'node:crypto'
import { PgBoss } from 'pg-boss'
import { expect, it, vi } from 'vitest'
import { createKnowledgeQueue, publishQueuedBuild } from '../src/runtime'
import { openLocalDatabase } from './local-database'
import { changeCapacityFixture } from './capacity-fixtures'
import { expectBlocked } from './build-race-fixtures'
import {
  expectPublishedCapacity,
  publicationState,
  publicationTransaction,
  withPublicationFixture,
} from './publication-fixtures'

type PublicationFixture = Parameters<Parameters<typeof withPublicationFixture>[0]>[0]
type QueuedPublicationFixture = PublicationFixture & {
  name: string
  envelope: { ownerId: string; operationId: string; buildId: string; receiptId: string }
  queue: ReturnType<typeof createKnowledgeQueue>
  job: { id: string; retryCount: number }
  maintenance: Awaited<ReturnType<typeof openLocalDatabase>>
}

async function queueState(fixture: QueuedPublicationFixture) {
  const { rows } = await fixture.maintenance.pool.query(
    'SELECT state::text AS state, retry_count AS retry FROM pgboss.job WHERE name = $1 AND id = $2',
    [fixture.name, fixture.job.id],
  )
  return rows
}

async function withQueuedPublication(work: (fixture: QueuedPublicationFixture) => Promise<void>) {
  await withPublicationFixture(async (fixture) => {
    const maintenance = await openLocalDatabase('migrator')
    const worker = await openLocalDatabase('worker')
    const name = `publication_${randomUUID().replaceAll('-', '')}`
    const administrator = new PgBoss({
      schema: 'pgboss',
      db: { executeSql: (statement, values) => maintenance.pool.query(statement, values) },
      createSchema: false,
      migrate: false,
      supervise: false,
      schedule: false,
    })
    administrator.on('error', () => {})
    try {
      await administrator.createQueue(name, {
        retryLimit: 1,
        retryDelay: 0,
        heartbeatSeconds: 60,
      })
      const envelope = {
        ownerId: fixture.owners[0],
        operationId: fixture.id,
        buildId: fixture.id,
        receiptId: fixture.id,
      }
      expect(await administrator.send(name, envelope, { id: fixture.id })).toBe(fixture.id)
      const queue = createKnowledgeQueue(worker.pool, name)
      const job = await queue.fetch()
      if (!job) throw new Error('Expected a real publication attempt')
      await work({ ...fixture, name, envelope, queue, job, maintenance })
    } finally {
      try {
        await administrator.deleteQueue(name)
      } finally {
        await Promise.all([maintenance.pool.end(), worker.pool.end()])
      }
    }
  })
}

it('publishes capacity and completes the real queue attempt on the same transaction', async () => {
  await withQueuedPublication(async (fixture) => {
    await expect(
      publicationTransaction(fixture, (transaction) =>
        publishQueuedBuild(transaction, fixture.name, fixture.job, fixture.envelope),
      ),
    ).resolves.toEqual({ replayed: false })
    await expectPublishedCapacity(fixture)
    expect(await queueState(fixture)).toEqual([{ state: 'completed', retry: 0 }])
    await expect(fixture.queue.fetch()).resolves.toBeNull()
    await expect(fixture.queue.complete(fixture.job)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    })
  })
})

it('treats uppercase UUID references as the same real job and envelope', async () => {
  await withQueuedPublication(async (fixture) => {
    await expect(
      publicationTransaction(fixture, (transaction) =>
        publishQueuedBuild(
          transaction,
          fixture.name,
          { ...fixture.job, id: fixture.job.id.toUpperCase() },
          {
            ...fixture.envelope,
            operationId: fixture.envelope.operationId.toUpperCase(),
            buildId: fixture.envelope.buildId.toUpperCase(),
            receiptId: fixture.envelope.receiptId.toUpperCase(),
          },
        ),
      ),
    ).resolves.toEqual({ replayed: false })
    await expectPublishedCapacity(fixture)
    expect(await queueState(fixture)).toEqual([{ state: 'completed', retry: 0 }])
  })
})

it.each(['attempt', 'heartbeat'] as const)(
  'refuses an expired %s before maintenance has changed the active job',
  async (expiry) => {
    await withQueuedPublication(async (fixture) => {
      await fixture.maintenance.pool.query(
        expiry === 'attempt'
          ? `UPDATE pgboss.job SET started_on = now() - (expire_seconds + 1) * interval '1s'
               WHERE name = $1 AND id = $2`
          : `UPDATE pgboss.job SET heartbeat_on = now() - interval '61 seconds'
               WHERE name = $1 AND id = $2`,
        [fixture.name, fixture.job.id],
      )
      const before = await publicationState(fixture)
      await expect(
        publicationTransaction(fixture, (transaction) =>
          publishQueuedBuild(transaction, fixture.name, fixture.job, fixture.envelope),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await publicationState(fixture)).toEqual(before)
      expect(await queueState(fixture)).toEqual([{ state: 'active', retry: 0 }])
    })
  },
)

it('refuses a real active job whose stored envelope belongs to another receipt', async () => {
  await withQueuedPublication(async (fixture) => {
    await fixture.maintenance.pool.query(
      'UPDATE pgboss.job SET data = $3::jsonb WHERE name = $1 AND id = $2',
      [
        fixture.name,
        fixture.job.id,
        JSON.stringify({ ...fixture.envelope, receiptId: randomUUID() }),
      ],
    )
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) =>
        publishQueuedBuild(transaction, fixture.name, fixture.job, fixture.envelope),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await publicationState(fixture)).toEqual(before)
    expect(await queueState(fixture)).toEqual([{ state: 'active', retry: 0 }])
  })
})

it('rolls back attempt completion when publication rejects an expired reservation', async () => {
  await withQueuedPublication(async (fixture) => {
    await changeCapacityFixture(
      fixture,
      `UPDATE knowledge.kb_reservations SET expires_at = now() - interval '1 second'
        WHERE owner_id = $1`,
    )
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) =>
        publishQueuedBuild(transaction, fixture.name, fixture.job, fixture.envelope),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await publicationState(fixture)).toEqual(before)
    expect(await queueState(fixture)).toEqual([{ state: 'active', retry: 0 }])
  })
})

it('rolls back publication, metering and queue completion when the enclosing transaction fails', async () => {
  await withQueuedPublication(async (fixture) => {
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, async (transaction) => {
        await publishQueuedBuild(transaction, fixture.name, fixture.job, fixture.envelope)
        throw new Error('synthetic outbox failure')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await publicationState(fixture)).toEqual(before)
    expect(await queueState(fixture)).toEqual([{ state: 'active', retry: 0 }])
  })
})

it('refuses a stale attempt without completing the real retry', async () => {
  await withQueuedPublication(async (fixture) => {
    await fixture.queue.fail(fixture.job, 'SERVICE_UNAVAILABLE')
    expect(await fixture.queue.fetch()).toMatchObject({ id: fixture.job.id, retryCount: 1 })
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) =>
        publishQueuedBuild(transaction, fixture.name, fixture.job, fixture.envelope),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await publicationState(fixture)).toEqual(before)
    expect(await queueState(fixture)).toEqual([{ state: 'active', retry: 1 }])
  })
})

it('does not publish or settle a job from another queue', async () => {
  await withQueuedPublication(async (fixture) => {
    const before = await publicationState(fixture)
    await expect(
      publicationTransaction(fixture, (transaction) =>
        publishQueuedBuild(transaction, `${fixture.name}_other`, fixture.job, fixture.envelope),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await publicationState(fixture)).toEqual(before)
    expect(await queueState(fixture)).toEqual([{ state: 'active', retry: 0 }])
  })
})

it('rechecks heartbeat expiry after a real queue-row lock wait', async () => {
  await withQueuedPublication(async (fixture) => {
    const observer = await openLocalDatabase('bootstrap')
    const probe = await observer.pool.connect()
    const writer = await fixture.maintenance.pool.connect()
    let waiting: Promise<unknown> | undefined
    try {
      const before = await publicationState(fixture)
      await writer.query('BEGIN')
      const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid
      await writer.query('SELECT id FROM pgboss.job WHERE name = $1 AND id = $2 FOR UPDATE', [
        fixture.name,
        fixture.job.id,
      ])
      let waiterPid = 0
      waiting = publicationTransaction(fixture, async (transaction) => {
        const result = await transaction.query('SELECT pg_backend_pid() AS pid')
        waiterPid = (result.rows[0] as { pid: number }).pid
        return publishQueuedBuild(transaction, fixture.name, fixture.job, fixture.envelope)
      })
      void waiting.catch(() => {})
      await vi.waitFor(() => expect(waiterPid).toBeGreaterThan(0))
      await expectBlocked(probe, waiterPid, writerPid)
      await writer.query(
        `UPDATE pgboss.job SET heartbeat_on = clock_timestamp() - interval '61 seconds'
          WHERE name = $1 AND id = $2`,
        [fixture.name, fixture.job.id],
      )
      await writer.query('COMMIT')
      await expect(waiting).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await publicationState(fixture)).toEqual(before)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      await waiting?.catch(() => {})
      probe.release()
      await observer.pool.end()
    }
    expect(await queueState(fixture)).toEqual([{ state: 'active', retry: 0 }])
  })
})
