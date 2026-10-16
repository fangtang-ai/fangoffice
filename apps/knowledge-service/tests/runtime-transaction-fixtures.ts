import { vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createKnowledgePrincipal } from '../src/identity'
import type { KnowledgeTransactionClient } from '../src/runtime'

export const now = () => 1000
export const principal = (subject = "owner-'雪") =>
  createKnowledgePrincipal(
    {
      issuer: 'https://issuer.example',
      audiences: ['knowledge'],
      subject,
      expiresAt: 2000,
      permissions: [],
    },
    { issuer: 'https://issuer.example', audience: 'knowledge' },
    now(),
  )

export function transactionFixture() {
  const events = new EventEmitter()
  const client = {
    query: vi.fn<KnowledgeTransactionClient['query']>(async () => ({
      rows: [{ owner_id: null }],
      rowCount: 1,
    })),
    release: vi.fn((_destroy: boolean) => {}),
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  }
  const pool = { connect: vi.fn(async () => client) }
  return { client, pool, events }
}
