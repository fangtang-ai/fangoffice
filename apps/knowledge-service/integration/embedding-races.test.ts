import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { recordEmbeddingIntent, recordEmbeddingResult, readEmbeddingAttempt } from '../src/runtime'
import { expectBlocked } from './build-race-fixtures'
import { withCapacityRace } from './capacity-race-fixtures'
import { embeddingIntent, embeddingResult, embeddingTransaction } from './embedding-fixtures'

it.each(['COMMIT', 'ROLLBACK'] as const)(
  'serializes identical intents across %s with a real lock wait',
  async (outcome) => {
    await withCapacityRace(
      async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
        const intent = embeddingIntent(fixture)
        await recordEmbeddingIntent(writer, intent)
        const waiting = recordEmbeddingIntent(waiter, intent)
        await expectBlocked(observer, waiterPid, writerPid)
        await writer.query(outcome)
        await expect(waiting).resolves.toMatchObject({ replayed: outcome === 'COMMIT' })
        await waiter.query('COMMIT')
      },
      'worker',
      'worker',
    )
  },
)

it('rejects a competing correction after its lock wait without splitting the usage chain', async () => {
  await withCapacityRace(
    async ({ fixture, writer, waiter, observer, writerPid, waiterPid }) => {
      const intent = embeddingIntent(fixture)
      const result = embeddingResult(intent.attemptId)
      await embeddingTransaction(fixture, async (transaction) => {
        await recordEmbeddingIntent(transaction, intent)
        await recordEmbeddingResult(transaction, result)
      })
      const correction = { ...embeddingResult(intent.attemptId), supersedesEventId: result.eventId }
      await recordEmbeddingResult(writer, correction)
      const waiting = expect(
        recordEmbeddingResult(waiter, { ...correction, eventId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
      await expectBlocked(observer, waiterPid, writerPid)
      await writer.query('COMMIT')
      await waiting
      await waiter.query('ROLLBACK')
      await expect(
        embeddingTransaction(fixture, (transaction) =>
          readEmbeddingAttempt(transaction, intent.attemptId),
        ),
      ).resolves.toMatchObject({ effective: { id: correction.eventId } })
    },
    'worker',
    'worker',
  )
})
