import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { readEmbeddingAttempt, recordEmbeddingIntent, recordEmbeddingResult } from '../src/runtime'
import { withCapacityFixture } from './capacity-fixtures'
import { embeddingIntent, embeddingResult, embeddingTransaction } from './embedding-fixtures'

it.each(['not_called', 'unknown', 'failed', 'completed'] as const)(
  'keeps the distinct %s cost outcome',
  async (callState) => {
    await withCapacityFixture(async (fixture) => {
      const intent = embeddingIntent(fixture)
      await embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingIntent(transaction, intent),
      )
      const result = {
        ...embeddingResult(intent.attemptId),
        callState,
        usage:
          callState === 'unknown'
            ? { source: 'unknown' as const, quantity: null }
            : {
                source:
                  callState === 'not_called'
                    ? ('reconciled' as const)
                    : ('provider_reported' as const),
                quantity: {
                  unit: 'tokens' as const,
                  value: callState === 'not_called' ? '0' : '17',
                },
              },
      }
      await embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingResult(transaction, result),
      )
      await expect(
        embeddingTransaction(fixture, (transaction) =>
          readEmbeddingAttempt(transaction, intent.attemptId),
        ),
      ).resolves.toMatchObject({
        effective: { callState, usage: result.usage, payer: 'platform', completion: 'none' },
      })
    })
  },
)

it('refuses sibling corrections but replays historical corrections after a later correction', async () => {
  await withCapacityFixture(async (fixture) => {
    const intent = embeddingIntent(fixture)
    const result = embeddingResult(intent.attemptId)
    const first = { ...embeddingResult(intent.attemptId), supersedesEventId: result.eventId }
    const second = {
      ...embeddingResult(intent.attemptId),
      supersedesEventId: first.eventId,
      usage: { source: 'reconciled' as const, quantity: { unit: 'tokens' as const, value: '11' } },
    }
    await embeddingTransaction(fixture, async (transaction) => {
      await recordEmbeddingIntent(transaction, intent)
      await recordEmbeddingResult(transaction, result)
      await recordEmbeddingResult(transaction, first)
      await recordEmbeddingResult(transaction, second)
      await expect(recordEmbeddingResult(transaction, first)).resolves.toMatchObject({
        replayed: true,
      })
    })
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingResult(transaction, { ...first, eventId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingResult(transaction, { ...first, supersedesEventId: intent.eventId }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        readEmbeddingAttempt(transaction, intent.attemptId),
      ),
    ).resolves.toMatchObject({
      effective: { id: second.eventId, usage: { quantity: { value: '11' } } },
    })
  })
})

it('refuses missing intents, unrelated predecessors, reused event IDs and conflicting outcomes', async () => {
  await withCapacityFixture(async (fixture) => {
    const intent = embeddingIntent(fixture)
    const other = embeddingIntent(fixture)
    const result = embeddingResult(intent.attemptId)
    await expect(
      embeddingTransaction(fixture, (transaction) => recordEmbeddingResult(transaction, result)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await embeddingTransaction(fixture, async (transaction) => {
      await recordEmbeddingIntent(transaction, intent)
      await recordEmbeddingIntent(transaction, other)
      await recordEmbeddingResult(transaction, result)
    })
    for (const conflict of [
      { ...result, eventId: randomUUID() },
      {
        ...result,
        usage: {
          source: 'provider_reported' as const,
          quantity: { unit: 'tokens' as const, value: '18' },
        },
      },
      { ...embeddingResult(other.attemptId), eventId: result.eventId },
    ])
      await expect(
        embeddingTransaction(fixture, (transaction) =>
          recordEmbeddingResult(transaction, conflict),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingResult(transaction, {
          ...embeddingResult(other.attemptId),
          supersedesEventId: result.eventId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

it('never revises a proven cache miss into a provider call and rolls back an uncommitted result', async () => {
  await withCapacityFixture(async (fixture) => {
    const intent = embeddingIntent(fixture)
    const cached = {
      ...embeddingResult(intent.attemptId),
      callState: 'not_called' as const,
      usage: { source: 'reconciled' as const, quantity: { unit: 'tokens' as const, value: '0' } },
    }
    await embeddingTransaction(fixture, (transaction) => recordEmbeddingIntent(transaction, intent))
    await expect(
      embeddingTransaction(fixture, async (transaction) => {
        await recordEmbeddingResult(transaction, cached)
        throw new Error('synthetic interruption')
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        readEmbeddingAttempt(transaction, intent.attemptId),
      ),
    ).resolves.toMatchObject({ effective: null })
    await embeddingTransaction(fixture, (transaction) => recordEmbeddingResult(transaction, cached))
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingResult(transaction, {
          ...embeddingResult(intent.attemptId),
          supersedesEventId: cached.eventId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
