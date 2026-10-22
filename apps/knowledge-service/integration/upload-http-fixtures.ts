import { rm } from 'node:fs/promises'
import { createKnowledgeClient } from '../../../packages/knowledge-client/src'
import { startKnowledgeApi, type KnowledgeSourceStore } from '../src/runtime'
import { accessToken, publicKeySet } from '../tests/runtime-auth-fixtures'
import {
  localApiConfig,
  syntheticDeletionJournalDirectory,
} from '../tests/runtime-service-fixtures'
import { withCapacityFixture, type CapacityFixture } from './capacity-fixtures'
import { openLocalDatabase } from './local-database'

export async function withUploadHttpFixture(
  work: (fixture: CapacityFixture, api: Awaited<ReturnType<typeof openUploadApi>>) => Promise<void>,
  configured = true,
  overrides: Record<string, string> = {},
  options: { uploadSource?: KnowledgeSourceStore } = {},
) {
  await withCapacityFixture(async (fixture) => {
    const api = await openUploadApi(fixture, configured, overrides, options)
    try {
      await work(fixture, api)
    } finally {
      api.client.close()
      await api.service.close()
      await rm(api.journalDirectory, { recursive: true, force: true })
    }
  })
}

async function openUploadApi(
  fixture: CapacityFixture,
  configured: boolean,
  overrides: Record<string, string>,
  options: { uploadSource?: KnowledgeSourceStore },
) {
  const { pool, settings } = await openLocalDatabase('api')
  const journalDirectory = syntheticDeletionJournalDirectory()
  const config = localApiConfig({
    KNOWLEDGE_DATABASE_NAME: settings.database,
    KNOWLEDGE_API_DATABASE_URL: `postgresql://${settings.roles.api.user}:${settings.roles.api.password}@127.0.0.1:55432/${settings.database}`,
    KNOWLEDGE_DELETION_JOURNAL_DIR: journalDirectory,
    ...(configured ? { KNOWLEDGE_UPLOAD_MAXIMUM_FILE_BYTES: '16' } : {}),
    ...overrides,
  })
  const service = await startKnowledgeApi(config, {
    ...options,
    poolFactory: () => pool,
    authentication: { fetch: async () => Response.json(publicKeySet) },
  }).catch(async (error: unknown) => {
    await pool.end()
    await rm(journalDirectory, { recursive: true, force: true })
    throw error
  })
  const tokenFor = (owner: string) =>
    accessToken({
      sub: owner,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
    })
  const token = await tokenFor(fixture.owners[0])
  const binding = {
    userId: fixture.owners[0],
    sessionId: 1,
    signal: new AbortController().signal,
  }
  const client = createKnowledgeClient({
    apiBase: () => service.origin,
    knowledgeBase: () => `${service.origin}/api/knowledge`,
    allowLoopback: true,
    bind: () => binding,
    isCurrent: () => true,
    token: async () => token,
  })
  return {
    service,
    client,
    pool,
    journalDirectory,
    tokenFor,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
}
