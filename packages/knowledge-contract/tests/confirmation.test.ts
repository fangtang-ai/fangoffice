import { expect, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeConfirmation } from '../src'
import { fixtureId, later } from './commerce-fixtures'
import { confirmation, conflict } from './decision-fixtures'

it('returns bounded paired evidence as needs_confirmation without a preferred source', () => {
  expect(parseKnowledgeConfirmation(confirmation)).toEqual(confirmation)
})

it.each([
  { label: 'no conflicts', input: { ...confirmation, conflicts: [] } },
  {
    label: 'too many pairs',
    input: {
      ...confirmation,
      conflicts: Array.from({ length: 11 }, (_, index) => ({
        ...conflict,
        id: fixtureId(index + 100),
      })),
    },
  },
  { label: 'duplicate conflict', input: { ...confirmation, conflicts: [conflict, conflict] } },
  { label: 'default source', input: { ...confirmation, defaultChoice: 'use_mcp' } },
  { label: 'self confirmation', input: { ...confirmation, status: 'confirmed' } },
  {
    label: 'style used as facts',
    input: {
      ...confirmation,
      conflicts: [{ ...conflict, private: { ...conflict.private, purpose: 'style' } }],
    },
  },
  {
    label: 'unbounded excerpt',
    input: {
      ...confirmation,
      conflicts: [{ ...conflict, mcp: { ...conflict.mcp, excerpt: 'x'.repeat(2001) } }],
    },
  },
  {
    label: 'missing source hash',
    input: {
      ...confirmation,
      conflicts: [{ ...conflict, private: { ...conflict.private, sourceHash: null } }],
    },
  },
  {
    label: 'raw supplier body',
    input: { ...confirmation, conflicts: [{ ...conflict, providerResponse: 'secret' }] },
  },
  { label: 'expired at creation', input: { ...confirmation, createdAt: later } },
  {
    label: 'evidence expires before prompt',
    input: {
      ...confirmation,
      conflicts: [
        { ...conflict, mcp: { ...conflict.mcp, validUntil: '2026-10-15T00:30:00.000Z' } },
      ],
    },
  },
  {
    label: 'evidence from the future',
    input: {
      ...confirmation,
      conflicts: [{ ...conflict, mcp: { ...conflict.mcp, observedAt: later } }],
    },
  },
])('rejects confirmation $label', ({ input }) => {
  expect(() => parseKnowledgeConfirmation(input)).toThrow(KnowledgeContractError)
})
