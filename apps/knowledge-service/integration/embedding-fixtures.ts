import { randomUUID } from 'node:crypto'
import type {
  EmbeddingIntentRequest,
  EmbeddingResultRequest,
  KnowledgeTransaction,
} from '../src/runtime'
import { capacityTransaction, type CapacityFixture } from './capacity-fixtures'

export const embeddingIntent = (fixture: CapacityFixture): EmbeddingIntentRequest => ({
  eventId: randomUUID(),
  attemptId: randomUUID(),
  indexProfileId: fixture.profileId,
  purpose: 'query',
  subject: { kind: 'query', runId: randomUUID(), callId: randomUUID() },
})

export const embeddingResult = (attemptId: string): EmbeddingResultRequest => ({
  eventId: randomUUID(),
  attemptId,
  callState: 'completed',
  usage: { source: 'provider_reported', quantity: { unit: 'tokens', value: '17' } },
})

export const embeddingTransaction = <Result>(
  fixture: CapacityFixture,
  work: (transaction: KnowledgeTransaction) => Promise<Result>,
) => capacityTransaction(fixture, work, fixture.owners[0], 'worker')
