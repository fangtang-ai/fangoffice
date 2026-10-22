import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { withCapacityFixture } from './capacity-fixtures'
import { embeddingTransaction } from './embedding-fixtures'

it.each([
  { field: 2, value: 'invalid' },
  { field: 3, value: 'estimated' },
  { field: 4, value: '0' },
  { field: 6, value: randomUUID() },
  { field: 7, value: null },
  { field: 8, value: null },
  { field: 9, value: null },
  { field: 10, value: 'document' },
])(
  'rejects invalid intent SQL argument $field without appending facts',
  async ({ field, value }) => {
    await withCapacityFixture(async (fixture) => {
      const values: unknown[] = [
        randomUUID(),
        randomUUID(),
        'intended',
        'unknown',
        null,
        null,
        null,
        randomUUID(),
        randomUUID(),
        fixture.profileId,
        'query',
      ]
      values[field] = value
      await embeddingTransaction(fixture, async (transaction) => {
        expect(
          (
            await transaction.query(
              'SELECT knowledge.record_embedding_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS status',
              values,
            )
          ).rows,
        ).toEqual([{ status: 'INVALID_REQUEST' }])
        expect(
          (
            await transaction.query('SELECT id FROM knowledge.kb_metering_events WHERE id = $1', [
              values[0],
            ])
          ).rows,
        ).toEqual([])
      })
    })
  },
)

it.each(['-1', '0.5', '9223372036854775808', 'NaN', 'Infinity'])(
  'rejects invalid provider quantity %s at the SQL boundary',
  async (quantity) => {
    await withCapacityFixture(async (fixture) => {
      await embeddingTransaction(fixture, async (transaction) => {
        expect(
          (
            await transaction.query(
              'SELECT knowledge.record_embedding_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS status',
              [
                randomUUID(),
                randomUUID(),
                'completed',
                'provider_reported',
                quantity,
                null,
                null,
                null,
                null,
                null,
                null,
              ],
            )
          ).rows,
        ).toEqual([{ status: 'INVALID_REQUEST' }])
      })
    })
  },
)
