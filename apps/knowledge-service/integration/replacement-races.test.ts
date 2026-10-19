import { expect, it, vi } from 'vitest'
import { reserveReplacementCapacity } from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { capacityState } from './capacity-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { prepareReplacement, replacementInput, replacementState } from './replacement-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes duplicate replacement credit after the first transaction %s',
  async (ending) => {
    await withCapacityRace(
      async ({ fixture: initial, writer, waiter, observer, writerPid, waiterPid }) => {
        const fixture = await prepareReplacement(initial)
        await reserveReplacementCapacity(writer, replacementInput(fixture))
        const waiting = reserveReplacementCapacity(waiter, replacementInput(fixture)).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
        await expectBlocked(observer, waiterPid, writerPid)
        await writer.query(ending)
        await expect(waiting).resolves.toEqual({ result: { replayed: ending === 'COMMIT' } })
        await waiter.query('COMMIT')
        expect(await capacityState(fixture)).toEqual({
          files: '0',
          bytes: '2',
          chunks: '2',
          physical: '32',
          reservations: 1,
          desired: fixture.replacementId,
        })
      },
    )
  },
)

it('rejects concurrent mismatched projections instead of borrowing the same base again', async () => {
  await withCapacityRace(
    async ({ fixture: initial, writer, waiter, observer, writerPid, waiterPid }) => {
      const fixture = await prepareReplacement(initial)
      await reserveReplacementCapacity(writer, replacementInput(fixture))
      const waiting = reserveReplacementCapacity(waiter, {
        ...replacementInput(fixture),
        chunks: 0n,
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query('COMMIT')
      await expect(waiting).resolves.toMatchObject({ error: { code: 'VERSION_CONFLICT' } })
      await waiter.query('COMMIT')
      expect(await capacityState(fixture)).toEqual({
        files: '0',
        bytes: '2',
        chunks: '2',
        physical: '32',
        reservations: 1,
        desired: fixture.replacementId,
      })
    },
  )
})

it('rechecks quota debt committed while the replacement waits for its owner lock', async () => {
  await withCapacityRace(async ({ fixture: initial, writer, observer, writerPid }) => {
    const fixture = await prepareReplacement(initial)
    const observerPid = (await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid
    await observer.query('BEGIN')
    try {
      await observer.query(
        'UPDATE knowledge.kb_quotas SET reserved_bytes = 1 WHERE owner_id = $1',
        [fixture.owners[0]],
      )
      const waiting = reserveReplacementCapacity(writer, replacementInput(fixture)).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, writerPid, observerPid)
      await observer.query('COMMIT')
      await expect(waiting).resolves.toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } })
      await writer.query('COMMIT')
      expect(await capacityState(fixture)).toEqual({
        files: '0',
        bytes: '1',
        chunks: '0',
        physical: '0',
        reservations: 0,
        desired: fixture.id,
      })
    } finally {
      await observer.query('ROLLBACK')
    }
  })
})

it('rejects a base invalidated while the replacement waits for its build lock', async () => {
  await withCapacityRace(async ({ fixture: initial, writer, observer, writerPid }) => {
    const fixture = await prepareReplacement(initial)
    const before = await replacementState(fixture)
    const observerPid = (await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid
    await observer.query('BEGIN')
    try {
      await observer.query(
        "UPDATE knowledge.kb_builds SET status = 'invalidated' WHERE owner_id = $1 AND id = $2",
        [fixture.owners[0], fixture.id],
      )
      const waiting = reserveReplacementCapacity(writer, replacementInput(fixture)).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, writerPid, observerPid)
      await observer.query('COMMIT')
      await expect(waiting).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
      await writer.query('COMMIT')
      expect(await replacementState(fixture)).toEqual(before)
    } finally {
      await observer.query('ROLLBACK')
    }
  })
})

it('refuses an admission deadline that expires during a confirmed quota-lock wait', async () => {
  await withCapacityRace(async ({ fixture: initial, writer, observer, writerPid }) => {
    const fixture = await prepareReplacement(initial)
    const before = await replacementState(fixture)
    const observerPid = (await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0]!.pid
    await observer.query('BEGIN')
    try {
      await observer.query(
        'SELECT owner_id FROM knowledge.kb_quotas WHERE owner_id = $1 FOR UPDATE',
        [fixture.owners[0]],
      )
      const input = { ...replacementInput(fixture), expiresAt: new Date(Date.now() + 500) }
      const waiting = reserveReplacementCapacity(writer, input).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      await expectBlocked(observer, writerPid, observerPid)
      await vi.waitFor(
        async () => {
          expect(
            (
              await observer.query('SELECT clock_timestamp() >= $1::timestamptz AS expired', [
                input.expiresAt.toISOString(),
              ])
            ).rows,
          ).toEqual([{ expired: true }])
        },
        { timeout: 1500, interval: 10 },
      )
      await observer.query('COMMIT')
      await expect(waiting).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } })
      await writer.query('COMMIT')
      expect(await replacementState(fixture)).toEqual(before)
    } finally {
      await observer.query('ROLLBACK')
    }
  })
})
