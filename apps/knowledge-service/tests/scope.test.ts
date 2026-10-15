import { expect, it } from 'vitest'
import { authorizeKnowledgeTarget, type KnowledgeResourceFacts } from '../src'
import {
  build,
  document,
  ids,
  now,
  otherOwnerId,
  ownerId,
  principal,
  resourceFacts,
  scope,
  space,
  target,
  version,
} from './fixtures'

it('authorizes only a same-owner active target inside the server-approved scope', () => {
  expect(
    authorizeKnowledgeTarget(principal(), target, resourceFacts(), scope, 'active', now),
  ).toEqual({ ownerId, target })
})

it('authorizes operation maintenance only with its exact owned operation snapshot', () => {
  const operation = {
    id: ids.operation,
    ...target,
    kind: 'upload',
    phase: 'ready',
    expectedGeneration: '1',
    targetVersionId: ids.version,
    error: null,
  }
  const operationTarget = { ...target, operationId: ids.operation }
  const facts = { ...resourceFacts(), operation: { ownerId, value: operation } }
  expect(
    authorizeKnowledgeTarget(principal(), operationTarget, facts, scope, 'maintenance', now).target,
  ).toEqual(operationTarget)
  expect(() =>
    authorizeKnowledgeTarget(
      principal(),
      operationTarget,
      { ...facts, operation: { ...facts.operation, ownerId: otherOwnerId } },
      scope,
      'maintenance',
      now,
    ),
  ).toThrow('NOT_FOUND')
})

it('accepts a bounded space scope without expanding it to every owner space', () => {
  expect(
    authorizeKnowledgeTarget(
      principal(),
      target,
      resourceFacts(),
      { kind: 'spaces', spaceIds: [ids.space] },
      'active',
      now,
    ).target,
  ).toEqual(target)
  expect(() =>
    authorizeKnowledgeTarget(
      principal(),
      target,
      resourceFacts(),
      { kind: 'spaces', spaceIds: [ids.operation] },
      'active',
      now,
    ),
  ).toThrow('FORBIDDEN')
})

it.each(['space', 'document', 'version', 'build'] as const)(
  'refuses another owner in every requested resource layer: %s',
  (layer) => {
    const facts: KnowledgeResourceFacts = resourceFacts()
    facts[layer] = { ...facts[layer]!, ownerId: otherOwnerId }
    expect(() =>
      authorizeKnowledgeTarget(
        principal(),
        { ...target, versionId: ids.version, buildId: ids.build },
        facts,
        scope,
        'active',
        now,
      ),
    ).toThrow('NOT_FOUND')
  },
)

it('refuses both a missing resource and an invented parent relationship', () => {
  expect(() =>
    authorizeKnowledgeTarget(
      principal(),
      target,
      { ...resourceFacts(), document: null },
      scope,
      'active',
      now,
    ),
  ).toThrow('NOT_FOUND')
  expect(() =>
    authorizeKnowledgeTarget(
      principal(),
      target,
      { ...resourceFacts(), document: { ownerId, value: { ...document, spaceId: ids.operation } } },
      scope,
      'active',
      now,
    ),
  ).toThrow('NOT_FOUND')
})

it('requires explicit history mode instead of silently substituting an old version', () => {
  const oldId = ids.operation
  const historicalTarget = { ...target, versionId: oldId }
  const facts = { ...resourceFacts(), version: { ownerId, value: { ...version, id: oldId } } }
  expect(() =>
    authorizeKnowledgeTarget(principal(), historicalTarget, facts, scope, 'active', now),
  ).toThrow('NOT_FOUND')
  expect(
    authorizeKnowledgeTarget(principal(), historicalTarget, facts, scope, 'history', now).target,
  ).toEqual(historicalTarget)
})

it.each(['building', 'invalidated', 'purged'])(
  'refuses a nonsealed build for evidence: %s',
  (status) => {
    const facts = {
      ...resourceFacts(),
      build: { ownerId, value: { ...build, status, manifestHash: null } },
    }
    expect(() =>
      authorizeKnowledgeTarget(
        principal(),
        { ...target, versionId: ids.version, buildId: ids.build },
        facts,
        scope,
        'history',
        now,
      ),
    ).toThrow('NOT_FOUND')
  },
)

it('does not turn a purged version or deleted document into historical evidence', () => {
  const versionTarget = { ...target, versionId: ids.version }
  expect(() =>
    authorizeKnowledgeTarget(
      principal(),
      versionTarget,
      {
        ...resourceFacts(),
        version: { ownerId, value: { ...version, purgedAt: '2026-10-14T00:00:00.000Z' } },
      },
      scope,
      'history',
      now,
    ),
  ).toThrow('NOT_FOUND')
  expect(() =>
    authorizeKnowledgeTarget(
      principal(),
      versionTarget,
      {
        ...resourceFacts(),
        document: {
          ownerId,
          value: { ...document, active: null, deletedAt: '2026-10-14T00:00:00.000Z' },
        },
      },
      scope,
      'history',
      now,
    ),
  ).toThrow('NOT_FOUND')
})

it('refuses frozen-space active evidence while keeping maintenance authorization separate', () => {
  const facts = { ...resourceFacts(), space: { ownerId, value: { ...space, state: 'frozen' } } }
  expect(() => authorizeKnowledgeTarget(principal(), target, facts, scope, 'active', now)).toThrow(
    'FORBIDDEN',
  )
  expect(
    authorizeKnowledgeTarget(principal(), target, facts, scope, 'maintenance', now).target,
  ).toEqual(target)
})

it('refuses forged principal copies and principals expired since authentication', () => {
  const identity = principal()
  expect(() =>
    authorizeKnowledgeTarget({ ...identity }, target, resourceFacts(), scope, 'active', now),
  ).toThrow('UNAUTHENTICATED')
  expect(() =>
    authorizeKnowledgeTarget(identity, target, resourceFacts(), scope, 'active', now + 3600000),
  ).toThrow('UNAUTHENTICATED')
})

it('rejects a caller owner, arbitrary path, mixed target or out-of-scope document', () => {
  for (const input of [
    { ...target, ownerId },
    { ...target, documentId: '../other' },
    { ...target, versionId: ids.version, operationId: ids.operation },
  ]) {
    expect(() =>
      authorizeKnowledgeTarget(principal(), input, resourceFacts(), scope, 'active', now),
    ).toThrow()
  }
  expect(() =>
    authorizeKnowledgeTarget(
      principal(),
      target,
      resourceFacts(),
      { kind: 'documents', documents: [{ ...target, documentId: ids.operation }] },
      'active',
      now,
    ),
  ).toThrow('FORBIDDEN')
})
