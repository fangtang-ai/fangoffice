import { expect, expectTypeOf, it } from 'vitest'
import { KnowledgeContractError, parseKnowledgeDecision } from '../src'
import { fixtureId, later } from './commerce-fixtures'
import { confirmation, conflict, decision, decisionContext } from './decision-fixtures'

it('binds an explicit user choice to this run and both exact evidence snapshots', () => {
  expect(parseKnowledgeDecision(decision, decisionContext)).toEqual(decision)
})

it.each(['use_mcp', 'use_private', 'keep_both'])(
  'preserves the explicit %s choice only for this run',
  (choice) => {
    const selected = { ...decision, choice }
    expect(parseKnowledgeDecision(selected, decisionContext)).toEqual(selected)
  },
)

it('records cancellation without producing a usable manifest or continuing generation', () => {
  const cancelled = { ...decision, status: 'cancelled', choice: 'cancel', newManifestId: null }
  const context = { ...decisionContext, currentEvidence: null, newManifestId: null }
  expect(parseKnowledgeDecision(cancelled, context)).toEqual(cancelled)
  const result = parseKnowledgeDecision(cancelled, context)
  if (result.status === 'cancelled') expectTypeOf(result.newManifestId).toEqualTypeOf<null>()
})

it('allows explicit cancellation after expiry but never a stale confirmation', () => {
  const cancelled = {
    ...decision,
    status: 'cancelled',
    choice: 'cancel',
    newManifestId: null,
    decidedAt: later,
  }
  const context = { ...decisionContext, now: later, currentEvidence: null, newManifestId: null }
  expect(parseKnowledgeDecision(cancelled, context)).toEqual(cancelled)
})

it.each([
  {
    label: 'model action source',
    input: decision,
    context: { ...decisionContext, channel: 'model_tool' },
  },
  {
    label: 'missing trusted source',
    input: decision,
    context: { ...decisionContext, channel: undefined },
  },
  {
    label: 'payload user claim',
    input: { ...decision, userConfirmed: true },
    context: decisionContext,
  },
  {
    label: 'implicit default',
    input: { ...decision, choice: undefined },
    context: decisionContext,
  },
  {
    label: 'global preference',
    input: { ...decision, rememberChoice: true },
    context: decisionContext,
  },
  { label: 'run drift', input: decision, context: { ...decisionContext, runId: fixtureId(99) } },
  {
    label: 'scope drift',
    input: decision,
    context: { ...decisionContext, scopeHash: 'b'.repeat(64) },
  },
  {
    label: 'policy drift',
    input: decision,
    context: { ...decisionContext, policyRevision: 'other' },
  },
  {
    label: 'wrong confirmation',
    input: { ...decision, confirmationId: fixtureId(99) },
    context: decisionContext,
  },
  {
    label: 'wrong conflict',
    input: { ...decision, conflictId: fixtureId(99) },
    context: decisionContext,
  },
  {
    label: 'old manifest changed',
    input: { ...decision, baseManifestId: fixtureId(99) },
    context: decisionContext,
  },
  {
    label: 'overwrite old manifest',
    input: { ...decision, newManifestId: confirmation.manifestId },
    context: { ...decisionContext, newManifestId: confirmation.manifestId },
  },
  {
    label: 'unassigned new manifest',
    input: { ...decision, newManifestId: fixtureId(99) },
    context: decisionContext,
  },
  { label: 'expired choice', input: decision, context: { ...decisionContext, now: later } },
  {
    label: 'future choice time',
    input: { ...decision, decidedAt: later },
    context: decisionContext,
  },
  {
    label: 'private version drift',
    input: decision,
    context: {
      ...decisionContext,
      currentEvidence: { ...conflict, private: { ...conflict.private, versionId: fixtureId(99) } },
    },
  },
  {
    label: 'private hash drift',
    input: decision,
    context: {
      ...decisionContext,
      currentEvidence: {
        ...conflict,
        private: { ...conflict.private, sourceHash: 'a'.repeat(64) },
      },
    },
  },
  {
    label: 'MCP hash drift',
    input: decision,
    context: {
      ...decisionContext,
      currentEvidence: { ...conflict, mcp: { ...conflict.mcp, evidenceHash: 'a'.repeat(64) } },
    },
  },
  {
    label: 'MCP call drift',
    input: decision,
    context: {
      ...decisionContext,
      currentEvidence: { ...conflict, mcp: { ...conflict.mcp, callId: fixtureId(99) } },
    },
  },
  {
    label: 'missing current evidence',
    input: decision,
    context: { ...decisionContext, currentEvidence: null },
  },
  {
    label: 'fabricated excerpt',
    input: {
      ...decision,
      evidence: { ...conflict, private: { ...conflict.private, excerpt: 'fabricated' } },
    },
    context: decisionContext,
  },
  {
    label: 'cancel keeps manifest',
    input: { ...decision, status: 'cancelled', choice: 'cancel' },
    context: decisionContext,
  },
  {
    label: 'cancel marked confirmed',
    input: { ...decision, choice: 'cancel' },
    context: decisionContext,
  },
  { label: 'owner injection', input: { ...decision, ownerId: 'forged' }, context: decisionContext },
])('rejects decision $label', ({ input, context }) => {
  expect(() => parseKnowledgeDecision(input, context)).toThrow(KnowledgeContractError)
})
