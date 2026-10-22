import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { onTestFinished } from 'vitest'
import { ids, now, ownerId } from './fixtures'
import type { KnowledgeDeletionJournal, KnowledgeDeletionIntent } from '../src/runtime'

export const deletionIntent = {
  schemaVersion: 1 as const, id: ids.operation, ownerId, recordedAt: now,
  scope: { kind: 'document' as const, spaceId: ids.space, documentId: ids.document },
}

export async function deletionJournalDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'fangoffice-deletion-'))
  onTestFinished(async () => {
    const [target, parent] = await Promise.all([realpath(directory), realpath(tmpdir())])
    if (dirname(target) !== parent || !basename(target).startsWith('fangoffice-deletion-')) throw new Error('Unexpected journal cleanup target')
    await rm(target, { recursive: true, force: true })
  })
  return directory
}

export async function collectDeletionIntents(journal: KnowledgeDeletionJournal) {
  const intents: KnowledgeDeletionIntent[] = []
  for await (const intent of journal.entries()) intents.push(intent)
  return intents
}
