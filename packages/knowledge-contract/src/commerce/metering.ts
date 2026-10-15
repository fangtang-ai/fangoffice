import { invalid } from '../validation'
import { matchSnapshot } from './common'
import { decodeMeteringEvent } from './metering-shapes'

export function parseKnowledgeMeteringEvent(input: unknown, previous: unknown = null) {
  const result = decodeMeteringEvent(input)
  if (
    result.payer === 'customer' &&
    (result.tariffRevision === null ||
      result.usage.source === 'unknown' ||
      result.usage.source === 'estimated')
  )
    invalid('meteringEvent.payer')
  if (result.dimension === 'storage' && result.subject.endAt > result.occurredAt)
    invalid('meteringEvent.occurredAt')
  if (result.dimension === 'embedding') {
    const query = result.subject.kind === 'query'
    if (query !== (result.purpose === 'query')) invalid('meteringEvent.purpose')
    if (
      (query && result.completion === 'published') ||
      (!query && result.completion === 'evidence_complete') ||
      (result.callState !== 'completed' && result.completion !== 'none')
    )
      invalid('meteringEvent.completion')
    if (
      (result.callState === 'intended' || result.callState === 'unknown') &&
      result.usage.source !== 'unknown'
    )
      invalid('meteringEvent.usage')
    if (
      result.callState === 'not_called' &&
      (result.usage.source !== 'reconciled' || result.usage.quantity.value !== '0')
    )
      invalid('meteringEvent.usage')
    if (
      result.payer === 'customer' &&
      (result.callState !== 'completed' ||
        result.completion === 'none' ||
        result.purpose === 'platform_rebuild')
    )
      invalid('meteringEvent.payer')
  }
  if (result.eventType === 'observation') {
    if (result.supersedesEventId !== null) invalid('meteringEvent.supersedesEventId')
  } else {
    const prior = decodeMeteringEvent(previous)
    if (
      result.supersedesEventId !== prior.id ||
      result.id === prior.id ||
      result.eventKey === prior.eventKey ||
      result.occurredAt < prior.occurredAt ||
      result.dimension !== prior.dimension ||
      result.usage.source === 'unknown' ||
      result.usage.source === 'estimated' ||
      (prior.tariffRevision !== null && result.tariffRevision !== prior.tariffRevision)
    )
      invalid('meteringEvent.correction')
    // A correction replaces the effective observation; it is never an extra usage sample.
    matchSnapshot(result.subject, prior.subject, 'meteringEvent.subject')
    if (
      result.dimension === 'embedding' &&
      prior.dimension === 'embedding' &&
      (result.attemptId !== prior.attemptId ||
        result.indexProfileId !== prior.indexProfileId ||
        result.purpose !== prior.purpose)
    )
      invalid('meteringEvent.attemptId')
  }
  return result
}

export type KnowledgeMeteringEvent = ReturnType<typeof parseKnowledgeMeteringEvent>
