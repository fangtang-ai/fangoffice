import { expect, it } from 'vitest'
import { createKnowledgeAdmissionPolicy } from '../src'
import { now, otherOwnerId, ownerId, principal } from './fixtures'
import { productPolicy, projection, quota } from './capacity-fixtures'

it('reserves positive logical deltas and independent physical bytes without mutating snapshots', () => {
  const value = quota()
  const before = structuredClone(value)
  expect(
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value },
      productPolicy(),
      projection,
      now,
    ),
  ).toEqual({
    positiveDelta: { files: '1', bytes: '200', chunks: '20' },
    physicalBytes: '300',
    remediation: false,
  })
  expect(value).toEqual(before)
})

it('refuses other products and future-dated entitlement or quota facts', () => {
  const admission = createKnowledgeAdmissionPolicy()
  const forged = productPolicy()
  Object.defineProperty(forged, 'product', { value: 'office_ai' })
  expect(() =>
    admission.capacity(principal(), { ownerId, value: quota() }, forged, projection, now),
  ).toThrow('NOT_CONFIGURED')
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId, value: quota() },
      productPolicy({ validFrom: now + 1 }),
      projection,
      now,
    ),
  ).toThrow('SERVICE_UNAVAILABLE')
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId, value: { ...quota(), updatedAt: '2026-10-15T00:00:01.000Z' } },
      productPolicy(),
      projection,
      now,
    ),
  ).toThrow('SERVICE_UNAVAILABLE')
})

it('never lends negative replacement deltas to unrelated concurrent reservations', () => {
  const replacement = {
    ...projection,
    next: { files: '1', bytes: '90', chunks: '15' },
    replaced: { files: '1', bytes: '100', chunks: '10' },
  }
  expect(
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value: quota() },
      productPolicy(),
      replacement,
      now,
    ).positiveDelta,
  ).toEqual({ files: '0', bytes: '0', chunks: '5' })
})

it('allows a verified nonincreasing replacement after downgrade, but still bounds physical storage', () => {
  const value = { ...quota(), limits: { files: '1', bytes: '100', chunks: '10' } }
  const replacement = {
    ...projection,
    next: { files: '1', bytes: '90', chunks: '10' },
    replaced: { files: '1', bytes: '100', chunks: '10' },
  }
  expect(
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value },
      productPolicy(),
      replacement,
      now,
    ).remediation,
  ).toBe(true)
  expect(() =>
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value },
      productPolicy(),
      { ...replacement, physicalBytes: '901' },
      now,
    ),
  ).toThrow('QUOTA_EXCEEDED')
  expect(() =>
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value },
      productPolicy(),
      { ...replacement, next: { ...replacement.next, chunks: '11' } },
      now,
    ),
  ).toThrow('QUOTA_EXCEEDED')
})

it.each(['files', 'bytes', 'chunks'] as const)(
  'counts active plus all reserved usage for %s',
  (dimension) => {
    const value = quota()
    value.active[dimension] = value.limits[dimension]
    expect(() =>
      createKnowledgeAdmissionPolicy().capacity(
        principal(),
        { ownerId, value },
        productPolicy(),
        projection,
        now,
      ),
    ).toThrow('QUOTA_EXCEEDED')
  },
)

it('keeps integer precision above Number.MAX_SAFE_INTEGER', () => {
  const value = {
    ...quota(),
    active: { files: '0', bytes: '9007199254740992', chunks: '0' },
    reserved: { files: '0', bytes: '0', chunks: '0' },
    limits: { files: '10', bytes: '9007199254740993', chunks: '100' },
  }
  const request = {
    next: { files: '1', bytes: '1', chunks: '1' },
    replaced: null,
    physicalBytes: '0',
  }
  expect(
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value },
      productPolicy(),
      request,
      now,
    ).positiveDelta.bytes,
  ).toBe('1')
  expect(() =>
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value },
      productPolicy(),
      { ...request, next: { ...request.next, bytes: '2' } },
      now,
    ),
  ).toThrow('QUOTA_EXCEEDED')
})

it.each(['frozen', 'closed'])('refuses new work for a %s owner', (ownerState) => {
  expect(() =>
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value: { ...quota(), ownerState } },
      productPolicy(),
      projection,
      now,
    ),
  ).toThrow('FORBIDDEN')
})

it('refuses another owner, stale policy, missing limits and unverified replacement credit', () => {
  const admission = createKnowledgeAdmissionPolicy()
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId: otherOwnerId, value: quota() },
      productPolicy(),
      projection,
      now,
    ),
  ).toThrow('FORBIDDEN')
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId, value: quota() },
      productPolicy({ ownerId: otherOwnerId }),
      projection,
      now,
    ),
  ).toThrow('FORBIDDEN')
  expect(() =>
    admission.capacity(principal(), { ownerId, value: quota() }, null, projection, now),
  ).toThrow('NOT_CONFIGURED')
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId, value: quota() },
      productPolicy({ validUntil: now }),
      projection,
      now,
    ),
  ).toThrow('SERVICE_UNAVAILABLE')
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId, value: quota() },
      productPolicy({ revision: 'other' }),
      projection,
      now,
    ),
  ).toThrow('SERVICE_UNAVAILABLE')
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId, value: { ...quota(), policyRevision: null, limits: null } },
      productPolicy(),
      projection,
      now,
    ),
  ).toThrow('NOT_CONFIGURED')
  expect(() =>
    admission.capacity(
      principal(),
      { ownerId, value: quota() },
      productPolicy(),
      { ...projection, replaced: { files: '6', bytes: '0', chunks: '0' } },
      now,
    ),
  ).toThrow('VERSION_CONFLICT')
})

it('permits synthetic policies only with the explicit isolated-test adapter mode', () => {
  const testPolicy = productPolicy({ source: 'internal_test' })
  expect(() =>
    createKnowledgeAdmissionPolicy().capacity(
      principal(),
      { ownerId, value: quota() },
      testPolicy,
      projection,
      now,
    ),
  ).toThrow('FORBIDDEN')
  expect(
    createKnowledgeAdmissionPolicy('isolated_test').capacity(
      principal(),
      { ownerId, value: quota() },
      testPolicy,
      projection,
      now,
    ).positiveDelta.bytes,
  ).toBe('200')
})
