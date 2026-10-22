import { deny } from '../errors'

export type KnowledgeDeletionScope =
  | Readonly<{ kind: 'owner' }>
  | Readonly<{ kind: 'space'; spaceId: string }>
  | Readonly<{ kind: 'document'; spaceId: string; documentId: string }>

export interface KnowledgeDeletionIntent {
  readonly schemaVersion: 1
  readonly id: string
  readonly ownerId: string
  readonly scope: KnowledgeDeletionScope
  readonly recordedAt: number
}

export interface KnowledgeDeletionWriter {
  append: (intent: KnowledgeDeletionIntent) => Promise<KnowledgeDeletionIntent>
}

export interface KnowledgeDeletionJournal extends KnowledgeDeletionWriter {
  entries: () => AsyncIterable<KnowledgeDeletionIntent>
}

export type KnowledgeDeletionApplier = (intent: KnowledgeDeletionIntent) => Promise<'DELETED' | 'PENDING'>

function object(value: unknown, keys: readonly string[]) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) deny('INVALID_REQUEST')
  return value as Record<string, unknown>
}

function uuid(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) deny('INVALID_REQUEST')
  return value.toLowerCase()
}

export function parseKnowledgeDeletionScope(value: unknown): KnowledgeDeletionScope {
  if (typeof value !== 'object' || value === null || !('kind' in value)) deny('INVALID_REQUEST')
  if (value.kind === 'owner') {
    object(value, ['kind'])
    return Object.freeze({ kind: 'owner' })
  }
  if (value.kind === 'space') {
    const input = object(value, ['kind', 'spaceId'])
    return Object.freeze({ kind: 'space', spaceId: uuid(input.spaceId) })
  }
  const input = object(value, ['kind', 'spaceId', 'documentId'])
  if (input.kind !== 'document') deny('INVALID_REQUEST')
  return Object.freeze({ kind: 'document', spaceId: uuid(input.spaceId), documentId: uuid(input.documentId) })
}

export function parseKnowledgeDeletionRequest(value: unknown) {
  const input = object(value, ['id', 'scope'])
  return { id: uuid(input.id), scope: parseKnowledgeDeletionScope(input.scope) }
}

export function parseKnowledgeDeletionIntent(value: unknown): KnowledgeDeletionIntent {
  const input = object(value, ['schemaVersion', 'id', 'ownerId', 'scope', 'recordedAt'])
  if (input.schemaVersion !== 1 || typeof input.ownerId !== 'string' || !input.ownerId ||
      input.ownerId.length > 512 || input.ownerId.trim() !== input.ownerId || /\p{Cc}/u.test(input.ownerId) ||
      typeof input.recordedAt !== 'number' || !Number.isSafeInteger(input.recordedAt) ||
      input.recordedAt < 0 || input.recordedAt > 8640000000000000) deny('INVALID_REQUEST')
  return Object.freeze({ schemaVersion: 1, id: uuid(input.id), ownerId: input.ownerId,
    scope: parseKnowledgeDeletionScope(input.scope), recordedAt: input.recordedAt })
}

export function deletionIntentIdentity(intent: KnowledgeDeletionIntent) {
  return JSON.stringify([intent.ownerId, intent.id, intent.scope])
}
