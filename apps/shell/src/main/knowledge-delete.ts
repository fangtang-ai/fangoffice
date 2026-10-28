import { randomUUID } from 'node:crypto'
import type { KnowledgeClient } from '@genoffice/knowledge-client'
import { parseKnowledgeDocumentTarget } from '@genoffice/knowledge-contract'
import { dialog, type BrowserWindow } from 'electron'

type DeletionContext = {
  client: KnowledgeClient
  window: BrowserWindow
  check: () => void
  signal: AbortSignal
}

export function createKnowledgeDocumentDeletion() {
  const sessions = new WeakMap<AbortSignal, Map<string, { intentId: string; title: string }>>()
  return async ({ client, window: host, check, signal }: DeletionContext, input: unknown) => {
    const target = parseKnowledgeDocumentTarget(input)
    check()
    const intents = sessions.get(signal) ?? new Map<string, { intentId: string; title: string }>()
    sessions.set(signal, intents)
    const key = `${target.spaceId}/${target.documentId}`
    const previous = intents.get(key)
    // A dispatched deletion may hide the document; recovery must reuse the original intent.
    const title = previous?.title ?? (await client.getDocument(target)).title
    check()
    const confirmation = await dialog.showMessageBox(host, {
      type: 'warning',
      title: '删除云端资料',
      message: previous ? '继续确认这次删除的结果？' : '确认删除该云端资料？',
      detail: `${title}\n删除会使该资料及其检索和来源不可用，无法撤销；不代表物理文件已清除或费用已退款。`,
      buttons: ['取消', previous ? '确认删除结果' : '删除资料'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal,
    })
    check()
    if (confirmation.response !== 1) return null
    // Account changes abort the session; repeated clicks reuse its intent without crossing accounts.
    const intent = intents.get(key) ?? { intentId: randomUUID(), title }
    intents.set(key, intent)
    return client.deleteDocument(target, { intentId: intent.intentId })
  }
}
