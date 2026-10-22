import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as runtime from '../src/runtime'
import { collectDeletionIntents, deletionIntent, deletionJournalDirectory } from './deletion-journal-fixtures'

it('persists an immutable intent outside PostgreSQL and reopens it through a fresh journal instance', async () => {
  const directory = await deletionJournalDirectory()
  const journal = await runtime.createFileDeletionJournal(directory)
  expect(await journal.append(deletionIntent)).toEqual(deletionIntent)
  const reopened = await runtime.createFileDeletionJournal(directory)
  expect(await collectDeletionIntents(reopened)).toEqual([deletionIntent])
  expect(journal).not.toHaveProperty('delete')
})

it('handles concurrent identical appends idempotently and refuses a scope change without overwriting the intent', async () => {
  const directory = await deletionJournalDirectory()
  const first = await runtime.createFileDeletionJournal(directory)
  const second = await runtime.createFileDeletionJournal(directory)
  const [left, right] = await Promise.all([first.append(deletionIntent), second.append({ ...deletionIntent, recordedAt: deletionIntent.recordedAt + 1 })])
  expect(left).toEqual(right)
  await expect(second.append({ ...deletionIntent, scope: { kind: 'owner' } })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  expect(await collectDeletionIntents(first)).toEqual([left])
  expect(await readdir(directory)).toHaveLength(1)
})

it('fails restoration closed when a committed journal object is corrupt', async () => {
  const directory = await deletionJournalDirectory()
  const journal = await runtime.createFileDeletionJournal(directory)
  await journal.append(deletionIntent)
  const [filename] = await readdir(directory)
  if (!filename) throw new Error('Expected committed journal object')
  await writeFile(join(directory, filename), '{"synthetic-corrupt-record":')
  await expect(collectDeletionIntents(journal)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
})
