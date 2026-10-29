import { expect, it, vi } from 'vitest'
import { createKnowledgeChatApi } from '../src'

it('exposes only fixed read-only IPC operations and unsubscribes account-change notifications', async () => {
  const invoke = vi.fn(async () => ({ ok: true, value: { items: [], nextCursor: null } }))
  const listeners = new Map<string, () => void>()
  const ipc = {
    invoke,
    on: (channel: string, listener: () => void) => listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
  }
  const api = createKnowledgeChatApi(ipc)
  await api.listDocuments(7, 'space', { cursor: 'next' })
  expect(invoke).toHaveBeenCalledWith('knowledge:chat:list-documents', 7, 'space', {
    cursor: 'next',
  })
  expect(Object.keys(api)).not.toContain('uploadText')
  expect(Object.keys(api)).not.toContain('deleteDocument')
  const changed = vi.fn()
  const dispose = api.onSessionChanged(changed)
  listeners.get('knowledge:chat:session-changed')!()
  expect(changed).toHaveBeenCalledOnce()
  dispose()
  expect(listeners.size).toBe(0)
})
