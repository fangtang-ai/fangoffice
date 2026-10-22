import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { readEmbeddingAttempt, recordEmbeddingIntent, recordEmbeddingResult } from '../src/runtime'
import { capacityTransaction, withCapacityFixture } from './capacity-fixtures'
import { embeddingIntent, embeddingResult, embeddingTransaction } from './embedding-fixtures'

it('normalizes uppercase UUIDs without changing an accepted attempt snapshot', async () => {
  await withCapacityFixture(async (fixture) => {
    const input = embeddingIntent(fixture)
    await embeddingTransaction(fixture, (transaction) => recordEmbeddingIntent(transaction, input))
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingIntent(transaction, {
          ...input,
          eventId: input.eventId.toUpperCase(),
          attemptId: input.attemptId.toUpperCase(),
          indexProfileId: input.indexProfileId.toUpperCase(),
        }),
      ),
    ).resolves.toMatchObject({ replayed: true, event: { id: input.eventId } })
    const result = embeddingResult(input.attemptId.toUpperCase())
    await embeddingTransaction(fixture, (transaction) => recordEmbeddingResult(transaction, result))
    await expect(
      embeddingTransaction(fixture, (transaction) =>
        readEmbeddingAttempt(transaction, input.attemptId.toUpperCase()),
      ),
    ).resolves.toMatchObject({ effective: { attemptId: input.attemptId } })
  })
})

it('keeps a committed intent unknown across transactions and replaces only the usage leaf', async () => {
  await withCapacityFixture(async (fixture) => {
    const attemptId = randomUUID()
    const input = {
      eventId: randomUUID(),
      attemptId,
      indexProfileId: fixture.profileId,
      subject: { kind: 'query' as const, runId: randomUUID(), callId: randomUUID() },
      purpose: 'query' as const,
    }
    const write = <Result>(work: Parameters<typeof capacityTransaction<Result>>[1]) =>
      capacityTransaction(fixture, work, fixture.owners[0], 'worker')
    await expect(
      write((transaction) => recordEmbeddingIntent(transaction, input)),
    ).resolves.toMatchObject({
      replayed: false,
      event: { callState: 'intended', usage: { quantity: null } },
    })
    await expect(
      write((transaction) => recordEmbeddingIntent(transaction, input)),
    ).resolves.toMatchObject({ replayed: true })
    await expect(
      write((transaction) => readEmbeddingAttempt(transaction, attemptId)),
    ).resolves.toMatchObject({ intent: { id: input.eventId }, effective: null })
    const result = {
      eventId: randomUUID(),
      attemptId,
      callState: 'unknown' as const,
      usage: { source: 'unknown' as const, quantity: null },
    }
    await write((transaction) => recordEmbeddingResult(transaction, result))
    const correction = {
      eventId: randomUUID(),
      attemptId,
      supersedesEventId: result.eventId,
      callState: 'completed' as const,
      usage: {
        source: 'provider_reported' as const,
        quantity: { unit: 'tokens' as const, value: '9007199254740993' },
      },
    }
    await write((transaction) => recordEmbeddingResult(transaction, correction))
    await expect(
      write((transaction) => recordEmbeddingResult(transaction, correction)),
    ).resolves.toMatchObject({ replayed: true })
    await expect(
      write((transaction) => readEmbeddingAttempt(transaction, attemptId)),
    ).resolves.toMatchObject({
      intent: { id: input.eventId },
      effective: {
        id: correction.eventId,
        purpose: 'query',
        payer: 'platform',
        completion: 'none',
        usage: {
          source: 'provider_reported',
          quantity: { unit: 'tokens', value: '9007199254740993' },
        },
      },
    })
  })
})
