import { expect, it } from 'vitest'
import { capacityState } from './capacity-fixtures'
import { cancellationState } from './cancellation-fixtures'
import { withRetryFixture } from './retry-fixtures'
import { inRoleTransaction } from './tenant-fixtures'

it('admits a fresh upload after cancellation at the current generation without forgiving physical debt', async () => {
  await withRetryFixture(async (fixture) => {
    for (const status of ['RESERVED', 'REPLAY'])
      expect(
        (
          await inRoleTransaction('api', fixture.owners[0], async (client) => {
            const result = await client.query(
              'SELECT knowledge.reserve_retry_capacity($1, 1, 16, $2) AS status',
              [fixture.retryId, fixture.expiresAt],
            )
            await client.query('COMMIT')
            return result
          })
        ).rows,
      ).toEqual([{ status }])
    expect(await capacityState(fixture)).toEqual({
      files: '1',
      bytes: '4',
      chunks: '1',
      physical: '32',
      reservations: 2,
      desired: fixture.retryId,
    })
    expect(await cancellationState(fixture, fixture.retryId)).toMatchObject({
      generation: '1',
      phase: 'queued',
      state: 'held',
      closed: false,
      active_build: null,
    })
    expect(await cancellationState(fixture)).toMatchObject({
      phase: 'cancelled',
      state: 'released',
      closed: true,
      builds: [{ id: fixture.id, status: 'invalidated', gc_state: 'live' }],
    })
  })
})
