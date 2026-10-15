import { expect, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeMeteringEvent } from '../src'
import { fixtureId, storageEvent, storageWindow } from './commerce-fixtures'

it('preserves a storage window and byte-time beyond int64 without a file build', () => {
  expect(parseKnowledgeMeteringEvent(storageEvent)).toEqual(storageEvent)
})

const unknownEvent = {
  ...storageEvent,
  payer: 'platform',
  usage: { source: 'unknown', quantity: null },
}
const correction = {
  ...storageEvent,
  id: fixtureId(20),
  eventKey: 'synthetic-storage-correction-1',
  eventType: 'correction',
  supersedesEventId: storageEvent.id,
}

it('preserves unknown storage quantity instead of fabricating zero', () => {
  expect(parseKnowledgeMeteringEvent(unknownEvent)).toEqual(unknownEvent)
})

it('links a reconciled correction to the same prior storage window', () => {
  expect(parseKnowledgeMeteringEvent(correction, unknownEvent)).toEqual(correction)
})

it.each([
  {
    label: 'wrong unit',
    input: {
      ...storageEvent,
      usage: { source: 'reconciled', quantity: { unit: 'bytes', value: '1' } },
    },
  },
  {
    label: 'unsafe number',
    input: {
      ...storageEvent,
      usage: { source: 'reconciled', quantity: { unit: 'byte_ms', value: 1 } },
    },
  },
  {
    label: 'unknown zero',
    input: {
      ...unknownEvent,
      usage: { source: 'unknown', quantity: { unit: 'byte_ms', value: '0' } },
    },
  },
  {
    label: 'known null',
    input: { ...storageEvent, usage: { source: 'reconciled', quantity: null } },
  },
  {
    label: 'estimated customer charge',
    input: {
      ...storageEvent,
      usage: { source: 'estimated', quantity: { unit: 'byte_ms', value: '1' } },
    },
  },
  { label: 'missing tariff', input: { ...storageEvent, tariffRevision: null } },
  { label: 'owner injection', input: { ...storageEvent, ownerId: 'forged' } },
  { label: 'wrong product', input: { ...storageEvent, product: 'policy_mcp' } },
  {
    label: 'empty window',
    input: { ...storageEvent, subject: { ...storageWindow, endAt: storageWindow.startAt } },
  },
  {
    label: 'watermark regression',
    input: { ...storageEvent, subject: { ...storageWindow, closingSequence: '1' } },
  },
  {
    label: 'wrong timezone',
    input: { ...storageEvent, subject: { ...storageWindow, timezone: 'UTC' } },
  },
  { label: 'fake build', input: { ...storageEvent, buildId: fixtureId(99) } },
])('rejects storage $label', ({ input }) => {
  expect(() => parseKnowledgeMeteringEvent(input)).toThrow(KnowledgeContractError)
})

it.each([
  { label: 'missing predecessor', prior: null, input: correction },
  {
    label: 'different predecessor',
    prior: { ...unknownEvent, id: fixtureId(99) },
    input: correction,
  },
  {
    label: 'scope drift',
    prior: unknownEvent,
    input: { ...correction, subject: { ...storageWindow, windowId: fixtureId(99) } },
  },
  { label: 'self reference', prior: unknownEvent, input: { ...correction, id: storageEvent.id } },
  {
    label: 'event key reuse',
    prior: unknownEvent,
    input: { ...correction, eventKey: storageEvent.eventKey },
  },
  {
    label: 'estimated correction',
    prior: unknownEvent,
    input: {
      ...correction,
      usage: { source: 'estimated', quantity: { unit: 'byte_ms', value: '1' } },
    },
  },
])('rejects correction $label', ({ input, prior }) => {
  expect(() => parseKnowledgeMeteringEvent(input, prior)).toThrow(KnowledgeContractError)
})
