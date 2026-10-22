import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { capacityTransaction, withCapacityFixture } from './capacity-fixtures'

it('durably records a query intent with unknown usage before any provider response', async () => {
  await withCapacityFixture(async (fixture) => {
    const eventId = randomUUID()
    const attemptId = randomUUID()
    await expect(
      capacityTransaction(
        fixture,
        (transaction) =>
          transaction.query(
            'SELECT knowledge.record_embedding_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS status',
            [
              eventId,
              attemptId,
              'intended',
              'unknown',
              null,
              null,
              null,
              randomUUID(),
              randomUUID(),
              fixture.profileId,
              'query',
            ],
          ),
        fixture.owners[0],
        'worker',
      ),
    ).resolves.toMatchObject({ rows: [{ status: 'RECORDED' }] })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query(
            `SELECT call_state, usage_source, quantity, payer, build_id, operation_id
           FROM knowledge.kb_metering_events WHERE id = $1`,
            [eventId],
          )
        ).rows,
      ).toEqual([
        {
          call_state: 'intended',
          usage_source: 'unknown',
          quantity: null,
          payer: 'platform',
          build_id: null,
          operation_id: null,
        },
      ])
    })
  })
})
