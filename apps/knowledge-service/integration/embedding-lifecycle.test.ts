import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { recordEmbeddingIntent, recordEmbeddingResult, readEmbeddingAttempt } from '../src/runtime'
import { bindSeedBuild } from './build-fixtures'
import {
  capacityTransaction,
  changeCapacityFixture,
  withCapacityFixture,
} from './capacity-fixtures'
import { embeddingIntent, embeddingResult, embeddingTransaction } from './embedding-fixtures'
import { admitPublication } from './publication-fixtures'

it.each(['document', 'user_rebuild', 'platform_rebuild'] as const)(
  'binds %s intent to the current admitted build and preserves late cost after deletion',
  async (purpose) => {
    await withCapacityFixture(async (fixture) => {
      await admitPublication(fixture)
      const input = {
        eventId: randomUUID(),
        attemptId: randomUUID(),
        indexProfileId: fixture.profileId,
        purpose,
        subject: { kind: 'operation' as const, buildId: fixture.id },
      }
      await expect(
        embeddingTransaction(fixture, (transaction) => recordEmbeddingIntent(transaction, input)),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await embeddingTransaction(fixture, (transaction) => bindSeedBuild(transaction, fixture))
      await expect(
        embeddingTransaction(fixture, (transaction) => recordEmbeddingIntent(transaction, input)),
      ).resolves.toMatchObject({
        event: {
          subject: {
            kind: 'operation',
            spaceId: fixture.id,
            documentId: fixture.id,
            versionId: fixture.id,
            operationId: fixture.id,
            buildId: fixture.id,
          },
          purpose,
        },
      })
      await capacityTransaction(fixture, (transaction) =>
        transaction.query("SELECT knowledge.apply_deletion_intent($1, 'document', $2, $3)", [
          randomUUID(),
          fixture.id,
          fixture.id,
        ]),
      )
      await expect(
        embeddingTransaction(fixture, (transaction) =>
          recordEmbeddingIntent(transaction, {
            ...input,
            eventId: randomUUID(),
            attemptId: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      const result = embeddingResult(input.attemptId)
      await embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingResult(transaction, result),
      )
      await expect(
        embeddingTransaction(fixture, (transaction) =>
          readEmbeddingAttempt(transaction, input.attemptId),
        ),
      ).resolves.toMatchObject({
        effective: { id: result.eventId, payer: 'platform', completion: 'none', purpose },
      })
    })
  },
)

it.each(['owner', 'profile'] as const)(
  'refuses new query intents after the %s changes but retains committed costs',
  async (change) => {
    await withCapacityFixture(async (fixture) => {
      const intent = embeddingIntent(fixture)
      await embeddingTransaction(fixture, (transaction) =>
        recordEmbeddingIntent(transaction, intent),
      )
      if (change === 'owner')
        await changeCapacityFixture(
          fixture,
          "UPDATE knowledge.kb_quotas SET owner_state = 'frozen' WHERE owner_id = $1",
        )
      else
        await changeCapacityFixture(
          fixture,
          `UPDATE knowledge.kb_quotas SET active_index_profile_id = NULL, policy_revision = NULL,
        limit_files = NULL, limit_bytes = NULL, limit_chunks = NULL WHERE owner_id = $1`,
        )
      await expect(
        embeddingTransaction(fixture, (transaction) =>
          recordEmbeddingIntent(transaction, embeddingIntent(fixture)),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(
        embeddingTransaction(fixture, (transaction) => recordEmbeddingIntent(transaction, intent)),
      ).resolves.toMatchObject({ replayed: true })
      await expect(
        embeddingTransaction(fixture, (transaction) =>
          recordEmbeddingResult(transaction, embeddingResult(intent.attemptId)),
        ),
      ).resolves.toMatchObject({ event: { indexProfileId: fixture.profileId, payer: 'platform' } })
    })
  },
)
