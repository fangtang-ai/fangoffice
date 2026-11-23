import { expect, expectTypeOf, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeMeteringEvent } from '../src'
import { embeddingEvent, fixtureId, operationSubject } from './commerce-fixtures'

it('meters a completed query by run/call without a document or build', () => {
  expect(parseKnowledgeMeteringEvent(embeddingEvent)).toEqual(embeddingEvent)
})

const intent = {
  ...embeddingEvent,
  payer: 'platform',
  tariffRevision: null,
  callState: 'intended',
  completion: 'none',
  usage: { source: 'unknown', quantity: null },
}
const cached = {
  ...embeddingEvent,
  payer: 'platform',
  callState: 'not_called',
  completion: 'none',
  usage: { source: 'reconciled', quantity: { unit: 'tokens', value: '0' } },
}

it.each([
  { label: 'pre-call intent', input: intent },
  { label: 'uncertain timeout', input: { ...intent, callState: 'unknown' } },
  { label: 'no-call cache', input: cached },
  {
    label: 'published document',
    input: {
      ...embeddingEvent,
      subject: operationSubject,
      purpose: 'document',
      completion: 'published',
    },
  },
  {
    label: 'failed supplier cost',
    input: { ...embeddingEvent, payer: 'platform', callState: 'failed', completion: 'none' },
  },
])('preserves $label separately from customer settlement', ({ input }) => {
  expect(parseKnowledgeMeteringEvent(input)).toEqual(input)
})

it('narrows unknown usage to null and query subjects without file fields', () => {
  const result = parseKnowledgeMeteringEvent(intent)
  if (result.dimension === 'embedding') {
    if (result.usage.source === 'unknown') expectTypeOf(result.usage.quantity).toEqualTypeOf<null>()
    if (result.subject.kind === 'query') expectTypeOf(result.subject).not.toHaveProperty('buildId')
  }
})

it.each([
  { label: 'query-purpose mismatch', input: { ...embeddingEvent, purpose: 'document' } },
  { label: 'operation-purpose mismatch', input: { ...embeddingEvent, subject: operationSubject } },
  {
    label: 'query fabricated build',
    input: { ...embeddingEvent, subject: { ...embeddingEvent.subject, buildId: fixtureId(99) } },
  },
  {
    label: 'cache fabricated tokens',
    input: { ...cached, usage: { source: 'reconciled', quantity: { unit: 'tokens', value: '1' } } },
  },
  {
    label: 'cache supplier usage',
    input: {
      ...cached,
      usage: { source: 'provider_reported', quantity: { unit: 'tokens', value: '0' } },
    },
  },
  {
    label: 'unknown fabricated zero',
    input: { ...intent, usage: { source: 'unknown', quantity: { unit: 'tokens', value: '0' } } },
  },
  {
    label: 'intended known zero',
    input: { ...intent, usage: { source: 'reconciled', quantity: { unit: 'tokens', value: '0' } } },
  },
  {
    label: 'failed customer charge',
    input: { ...embeddingEvent, callState: 'failed', completion: 'none' },
  },
  { label: 'unpublished customer charge', input: { ...embeddingEvent, completion: 'none' } },
  {
    label: 'platform rebuild customer charge',
    input: {
      ...embeddingEvent,
      subject: operationSubject,
      purpose: 'platform_rebuild',
      completion: 'published',
    },
  },
  { label: 'query published file', input: { ...embeddingEvent, completion: 'published' } },
  {
    label: 'file completed evidence stage',
    input: { ...embeddingEvent, subject: operationSubject, purpose: 'document' },
  },
  {
    label: 'failed published content',
    input: { ...embeddingEvent, payer: 'platform', callState: 'failed', completion: 'published' },
  },
  {
    label: 'wrong quantity unit',
    input: {
      ...embeddingEvent,
      usage: { source: 'provider_reported', quantity: { unit: 'byte_ms', value: '1' } },
    },
  },
  { label: 'raw supplier error', input: { ...intent, providerError: 'secret upstream response' } },
])('rejects embedding $label', ({ input }) => {
  expect(() => parseKnowledgeMeteringEvent(input)).toThrow(KnowledgeContractError)
})

it('reconciles an uncertain attempt without changing its identity', () => {
  const correction = {
    ...embeddingEvent,
    id: fixtureId(21),
    eventKey: 'synthetic-query-correction',
    eventType: 'correction',
    supersedesEventId: intent.id,
  }
  expect(parseKnowledgeMeteringEvent(correction, intent)).toEqual(correction)
  expect(() =>
    parseKnowledgeMeteringEvent({ ...correction, attemptId: fixtureId(99) }, intent),
  ).toThrow(KnowledgeContractError)
})
