import { expect } from 'vitest'
import {
  createKnowledgeReplayPrincipal,
  readEmbeddingAttempt,
  recordEmbeddingIntent,
  recordEmbeddingResult,
  withKnowledgeTransaction,
} from '../src/runtime'
import type { BuildFixture } from './build-fixtures'
import { embeddingIntent, embeddingResult } from './embedding-fixtures'
import { openLocalDatabase } from './local-database'

export async function prepareEmbeddingRecovery(fixture: BuildFixture) {
  const { pool } = await openLocalDatabase('worker')
  const principal = createKnowledgeReplayPrincipal(fixture.owners[0], {
    issuer: 'https://synthetic.invalid',
    audience: 'local-knowledge',
  })
  const intent = embeddingIntent({ ...fixture, expiresAt: new Date().toISOString() })
  const interrupted = embeddingIntent({ ...fixture, expiresAt: new Date().toISOString() })
  const result = embeddingResult(intent.attemptId)
  const correction = { ...embeddingResult(intent.attemptId), supersedesEventId: result.eventId }
  try {
    const attempt = await withKnowledgeTransaction(pool, principal, async (transaction) => {
      await recordEmbeddingIntent(transaction, intent)
      await recordEmbeddingIntent(transaction, interrupted)
      await recordEmbeddingResult(transaction, result)
      await recordEmbeddingResult(transaction, correction)
      return readEmbeddingAttempt(transaction, intent.attemptId)
    })
    return { fixture, intent, interrupted, result, correction, attempt }
  } finally {
    await pool.end()
  }
}

export async function verifyRestoredEmbedding(
  recovery: Awaited<ReturnType<typeof prepareEmbeddingRecovery>>,
) {
  const { pool } = await openLocalDatabase('worker', 'restore')
  const principal = createKnowledgeReplayPrincipal(recovery.fixture.owners[0], {
    issuer: 'https://synthetic.invalid',
    audience: 'local-knowledge',
  })
  try {
    await withKnowledgeTransaction(pool, principal, async (transaction) => {
      expect(await readEmbeddingAttempt(transaction, recovery.intent.attemptId)).toEqual(
        recovery.attempt,
      )
      await expect(recordEmbeddingIntent(transaction, recovery.intent)).resolves.toMatchObject({
        replayed: true,
      })
      await expect(recordEmbeddingResult(transaction, recovery.result)).resolves.toMatchObject({
        replayed: true,
      })
      await expect(recordEmbeddingResult(transaction, recovery.correction)).resolves.toMatchObject({
        replayed: true,
      })
      await expect(
        readEmbeddingAttempt(transaction, recovery.interrupted.attemptId),
      ).resolves.toMatchObject({
        effective: null,
        intent: { usage: { source: 'unknown', quantity: null } },
      })
      await recordEmbeddingResult(transaction, {
        ...embeddingResult(recovery.interrupted.attemptId),
        callState: 'unknown',
        usage: { source: 'unknown', quantity: null },
      })
      await expect(
        readEmbeddingAttempt(transaction, recovery.interrupted.attemptId),
      ).resolves.toMatchObject({ effective: { usage: { source: 'unknown', quantity: null } } })
    })
  } finally {
    await pool.end()
  }
}
