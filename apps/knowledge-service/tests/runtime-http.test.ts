import { request as httpRequest } from 'node:http'
import { rm } from 'node:fs/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createFileDeletionJournal, startKnowledgeApi } from '../src/runtime'
import { collectDeletionIntents } from './deletion-journal-fixtures'
import { transactionalServicePool } from './runtime-service-fixtures'
import { accessToken, publicKeySet } from './runtime-auth-fixtures'
import {
  localApiConfig,
  syntheticDeletionJournalDirectory,
  syntheticPool,
} from './runtime-service-fixtures'
import { now, ids, ownerId, target } from './fixtures'

async function serviceFixture() {
  const pool = syntheticPool()
  const journalDirectory = syntheticDeletionJournalDirectory()
  onTestFinished(async () => {
    await rm(journalDirectory, { recursive: true, force: true })
  })
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json(publicKeySet))
  const service = await startKnowledgeApi(
    localApiConfig({ KNOWLEDGE_DELETION_JOURNAL_DIR: journalDirectory }),
    {
      poolFactory: () => pool,
      authentication: { fetch: transport, now: () => now },
      shutdownTimeoutMs: 100,
    },
  )
  const headers = { Authorization: `Bearer ${await accessToken()}` }
  return { ...service, pool, transport, headers, journalDirectory }
}

it('exposes bounded control endpoints but no CORS, credentials, database identity or business payload', async () => {
  const service = await serviceFixture()
  try {
    expect((await fetch(`${service.origin}/readyz`)).status).toBe(200)
    const unsupported = await fetch(`${service.origin}/api/knowledge/unimplemented`, {
      headers: service.headers,
    })
    expect(await unsupported.json()).toEqual({ code: 'NOT_FOUND', requestId: null })
    expect(unsupported.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(unsupported.headers.get('Set-Cookie')).toBeNull()
    for (const path of [
      '/api/knowledge/status?owner=forged',
      '/api/knowledge/%73tatus',
      '/unknown',
    ]) {
      expect((await fetch(`${service.origin}${path}`, { headers: service.headers })).status).toBe(
        404,
      )
    }
    expect(service.pool.query).toHaveBeenCalledOnce()
  } finally {
    await service.close()
  }
})

it('rejects methods and body-bearing requests without invoking authentication or a database transaction', async () => {
  const service = await serviceFixture()
  try {
    const method = await fetch(`${service.origin}/api/knowledge/status`, { method: 'PUT' })
    expect(method.status).toBe(405)
    expect(method.headers.get('Allow')).toBe('GET')
    expect(service.transport).not.toHaveBeenCalled()
    const body = await fetch(`${service.origin}/api/knowledge/status`, {
      method: 'POST',
      body: 'synthetic-private-document',
    })
    expect(body.status).toBe(413)
    expect(await body.json()).toEqual({ code: 'INVALID_REQUEST', requestId: null })
    expect(service.transport).not.toHaveBeenCalled()
    expect(service.pool.query).toHaveBeenCalledOnce()
  } finally {
    await service.close()
  }
})

it('rejects duplicate bearer headers rather than relying on the HTTP parser to pick one', async () => {
  const service = await serviceFixture()
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${service.origin}/api/knowledge/status`,
        { headers: { Authorization: [service.headers.Authorization, 'Bearer forged'] } },
        (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode))
        },
      )
      request.once('error', reject)
      request.end()
    })
    expect(status).toBe(401)
    expect(service.transport).not.toHaveBeenCalled()
  } finally {
    await service.close()
  }
})

it.each(['malformed', 'unavailable', 'invalid-signature'])(
  'returns only stable authentication diagnostics: %s',
  async (mode) => {
    const service = await serviceFixture()
    try {
      if (mode === 'unavailable')
        service.transport.mockRejectedValue(new Error('synthetic-private-issuer-diagnostic'))
      const authorization =
        mode === 'malformed'
          ? 'Basic synthetic-private-password'
          : mode === 'invalid-signature'
            ? `Bearer ${await accessToken({ aud: 'wrong-resource' })}`
            : service.headers.Authorization
      const response = await fetch(`${service.origin}/api/knowledge/status`, {
        headers: { Authorization: authorization },
      })
      expect(response.status).toBe(mode === 'unavailable' ? 503 : 401)
      expect(await response.json()).toEqual({
        code: mode === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'UNAUTHENTICATED',
        requestId: null,
      })
      expect(service.pool.query).toHaveBeenCalledOnce()
    } finally {
      await service.close()
    }
  },
)

it('isolates a disconnected client from the shared JWKS lookup', async () => {
  const service = await serviceFixture()
  let release!: (response: Response) => void
  service.transport.mockReturnValue(
    new Promise<Response>((resolve) => {
      release = resolve
    }),
  )
  const controller = new AbortController()
  const cancelled = fetch(`${service.origin}/api/knowledge/status`, {
    headers: service.headers,
    signal: controller.signal,
  }).catch(() => undefined)
  try {
    await vi.waitFor(() => expect(service.transport).toHaveBeenCalledOnce())
    controller.abort()
    const active = fetch(`${service.origin}/api/knowledge/status`, { headers: service.headers })
    release(Response.json(publicKeySet))
    expect((await active).status).toBe(200)
    expect(service.transport).toHaveBeenCalledOnce()
  } finally {
    release(Response.json(publicKeySet))
    await cancelled
    await service.close()
  }
})

it('rejects non-DELETE methods on the deletion endpoint after authentication', async () => {
  const service = await serviceFixture()
  try {
    const response = await fetch(`${service.origin}/api/knowledge/deletions`, {
      headers: service.headers,
    })
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('DELETE')
    expect(service.pool.connect).not.toHaveBeenCalled()
  } finally {
    await service.close()
  }
})

it('persists a confirmed deletion intent outside PostgreSQL before the database converges', async () => {
  const { pool, client } = transactionalServicePool()
  const journalDirectory = syntheticDeletionJournalDirectory()
  onTestFinished(async () => {
    await rm(journalDirectory, { recursive: true, force: true })
  })
  const service = await startKnowledgeApi(
    localApiConfig({ KNOWLEDGE_DELETION_JOURNAL_DIR: journalDirectory }),
    {
      poolFactory: () => pool,
      authentication: { fetch: vi.fn(async () => Response.json(publicKeySet)), now: () => now },
      shutdownTimeoutMs: 100,
    },
  )
  try {
    client.query.mockImplementation(async (statement: string) =>
      statement.startsWith('SELECT knowledge.apply_deletion_intent')
        ? { rows: [{ status: 'DELETED' }], rowCount: 1 }
        : { rows: [{ owner_id: null }], rowCount: 1 },
    )
    const response = await fetch(`${service.origin}/api/knowledge/deletions`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({
        id: ids.document,
        scope: { kind: 'document', spaceId: ids.space, documentId: ids.document },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ intentId: ids.document, phase: 'deleted' })
    const reopened = await createFileDeletionJournal(journalDirectory)
    const [recorded] = await collectDeletionIntents(reopened)
    expect(recorded).toMatchObject({
      schemaVersion: 1,
      id: ids.document,
      ownerId,
      scope: { kind: 'document', spaceId: ids.space, documentId: ids.document },
    })
    expect(client.query.mock.calls.map(([statement]) => String(statement))).toContain(
      'SELECT knowledge.apply_deletion_intent($1, $2, $3, $4) AS status',
    )
  } finally {
    await service.close()
  }
})

it('rejects malformed deletion scopes at the trust boundary without recording or converging', async () => {
  const { pool, client } = transactionalServicePool()
  const journalDirectory = syntheticDeletionJournalDirectory()
  onTestFinished(async () => {
    await rm(journalDirectory, { recursive: true, force: true })
  })
  const service = await startKnowledgeApi(
    localApiConfig({ KNOWLEDGE_DELETION_JOURNAL_DIR: journalDirectory }),
    {
      poolFactory: () => pool,
      authentication: { fetch: vi.fn(async () => Response.json(publicKeySet)), now: () => now },
      shutdownTimeoutMs: 100,
    },
  )
  try {
    const response = await fetch(`${service.origin}/api/knowledge/deletions`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({ id: 'not-a-uuid', scope: { kind: 'documents', documents: [target] } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: 'INVALID_REQUEST', requestId: null })
    const reopened = await createFileDeletionJournal(journalDirectory)
    expect(await collectDeletionIntents(reopened)).toEqual([])
    expect(client.query).not.toHaveBeenCalled()
  } finally {
    await service.close()
  }
})
