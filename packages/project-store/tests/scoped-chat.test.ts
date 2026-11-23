import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ProjectStore, createScopedChatStore } from '../src'

it('keeps retrieved cloud text out of another account’s restored conversation and project timeline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scoped-knowledge-chat-'))
  try {
    const store = new ProjectStore(directory)
    store.ensureDefaultProject()
    const accountA = createScopedChatStore(store, 'account-A')
    const accountB = createScopedChatStore(store, 'account-B')
    expect(() => accountA.resolve(null, 'unsaved-legacy')).toThrow('project:unscoped-history')
    const file = join(directory, 'report.docx')
    const first = accountA.resolve(file)
    accountA.append({ ...first, role: 'assistant', text: '仅A可见的云端原文 [K1]' })
    const second = accountB.resolve(file)
    expect(second.chatId).not.toBe(first.chatId)
    expect(accountB.load(second)).toEqual([])
    expect(() => accountB.load(first)).toThrow('project:account-changed')
    expect(() =>
      accountB.load({ ...second, chatId: `${second.chatId}/../${first.chatId}` }),
    ).toThrow('project:account-changed')
    expect(() => accountB.resolve(null, '../another-account')).toThrow('project:invalid-chat-id')
    expect(() => accountB.append({ ...first, role: 'assistant', text: 'late A result' })).toThrow(
      'project:account-changed',
    )
    expect(accountB.timeline('default')).toEqual([])
    expect(accountA.load(first)).toMatchObject([{ text: '仅A可见的云端原文 [K1]' }])
    expect(accountA.timeline('default')).toMatchObject([
      { filePath: file, preview: '仅A可见的云端原文 [K1]' },
    ])
    const draft = accountA.resolve(null, 'unsaved-cloud-chat')
    accountA.append({ ...draft, role: 'assistant', text: '草稿知识引用 [K2]' })
    const savedFile = join(directory, 'saved.docx')
    const saved = accountA.rebind(
      { projectId: draft.projectId, tempChatId: draft.chatId },
      savedFile,
    )
    expect(accountA.load(saved)).toMatchObject([{ text: '草稿知识引用 [K2]' }])
    const project = store.createProject('隔离资料项目')
    store.moveFileToProject(savedFile, project.id)
    const moved = accountA.resolve(savedFile)
    expect(moved.projectId).toBe(project.id)
    expect(accountA.load(moved)).toMatchObject([{ text: '草稿知识引用 [K2]' }])
    expect(accountB.timeline(project.id)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
