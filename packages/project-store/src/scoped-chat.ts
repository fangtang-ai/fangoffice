import { createHash } from 'node:crypto'
import type { AppendChatArgs, LoadChatArgs, RebindChatArgs } from './ipc.js'
import type { ProjectStore } from './store.js'

export function createScopedChatStore(store: ProjectStore, accountId: string | null) {
  const prefix = `account-${createHash('sha256')
    .update(accountId === null ? 'guest' : `user:${accountId}`)
    .digest('hex')
    .slice(0, 24)}-`
  const scopedId = (chatId: string) => {
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(chatId))
      throw new Error('project:invalid-chat-id')
    return `${prefix}${chatId}`
  }
  const check = (chatId: string) => {
    if (
      typeof chatId !== 'string' ||
      !chatId.startsWith(prefix) ||
      !/^[a-zA-Z0-9._-]+$/.test(chatId)
    )
      throw new Error('project:account-changed')
  }
  return {
    resolve(filePath: string | null, tempChatId = `unsaved-${Date.now()}`) {
      if (!filePath && tempChatId === 'unsaved-legacy') throw new Error('project:unscoped-history')
      const target = filePath
        ? store.resolveChatForFile(filePath)
        : { projectId: 'default', chatId: tempChatId }
      return { ...target, chatId: scopedId(target.chatId) }
    },
    append(args: AppendChatArgs) {
      check(args.chatId)
      const { projectId, chatId, ...message } = args
      store.appendChatMessage(projectId, chatId, message)
    },
    load(args: LoadChatArgs) {
      check(args.chatId)
      return store.loadChat(args.projectId, args.chatId, args.limit ?? 200)
    },
    rebind(args: RebindChatArgs, filePath: string | null) {
      check(args.tempChatId)
      if (filePath) return store.rebindChatToFile(args.projectId, args.tempChatId, filePath, prefix)
      const chatId = args.newChatId ? scopedId(args.newChatId) : args.tempChatId
      if (chatId !== args.tempChatId) store.rebindChat(args.projectId, args.tempChatId, chatId)
      return { projectId: args.projectId, chatId }
    },
    timeline(projectId: string, limit = 20) {
      return store.getProjectTimeline(projectId, limit, prefix)
    },
  }
}
