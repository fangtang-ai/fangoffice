import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { capacityTransaction } from './capacity-fixtures'
import { uploadMetadata } from './upload-fixtures'
import { withUploadHttpFixture } from './upload-http-fixtures'

it('creates metadata and replays one committed upload through the account client and real API role', async () => {
  await withUploadHttpFixture(async (fixture, { client }) => {
    const spaceId = randomUUID()
    const documentId = randomUUID()
    const target = { spaceId, documentId }
    const upload = {
      operationId: randomUUID(),
      idempotencyKey: randomUUID(),
      expectedGeneration: '0',
      declaredBytes: '4',
      format: 'txt',
    }
    expect(await client.createSpace({ spaceId }, { title: 'Synthetic space' })).toMatchObject({
      id: spaceId,
      state: 'active',
    })
    expect(await client.createDocument(target, uploadMetadata)).toMatchObject({
      id: documentId,
      generation: '0',
      active: null,
    })
    const first = await client.prepareUpload(target, upload)
    expect(first).toMatchObject({
      operation: { id: upload.operationId, phase: 'uploading', targetVersionId: null },
      preparation: { status: 'prepared', maximumBytes: '4', format: 'txt' },
    })
    expect(await client.prepareUpload(target, { ...upload, operationId: randomUUID() })).toEqual(
      first,
    )
    await expect(client.createSpace({ spaceId }, { title: 'Changed' })).rejects.toMatchObject({
      problem: { code: 'VERSION_CONFLICT' },
    })
    await capacityTransaction(fixture, async (transaction) => {
      expect(
        (
          await transaction.query('SELECT id FROM knowledge.kb_versions WHERE document_id = $1', [
            documentId,
          ])
        ).rows,
      ).toEqual([])
    })
    expect(JSON.stringify(first)).not.toMatch(/staging\/|bucket|https?:\/\//)
  })
})

it('rejects invalid JSON, injection, body bounds and unsupported methods before a transaction', async () => {
  await withUploadHttpFixture(async (_fixture, { service, pool, headers }) => {
    const connect = vi.spyOn(pool, 'connect')
    const path = `${service.origin}/api/knowledge/spaces/${randomUUID()}`
    for (const body of ['{', JSON.stringify({ title: 'Synthetic', ownerId: 'forged' })]) {
      const response = await fetch(path, { method: 'PUT', headers, body })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: 'INVALID_REQUEST', requestId: null })
    }
    expect(
      (
        await fetch(path, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'text/plain' },
          body: JSON.stringify({ title: 'Synthetic' }),
        })
      ).status,
    ).toBe(400)
    expect((await fetch(path, { method: 'PUT', headers, body: 'x'.repeat(20000) })).status).toBe(
      413,
    )
    const wrongMethod = await fetch(path, { method: 'POST', headers, body: '{}' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('Allow')).toBe('PUT')
    expect(
      (
        await fetch(path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{"title":"Synthetic"}',
        })
      ).status,
    ).toBe(401)
    expect(connect).not.toHaveBeenCalled()
    connect.mockRestore()
  })
})

it('enforces owner isolation, generation, quota and explicit server file policy over HTTP', async () => {
  await withUploadHttpFixture(async (fixture, { service, client, headers, tokenFor }) => {
    const target = { spaceId: randomUUID(), documentId: randomUUID() }
    await client.createSpace({ spaceId: target.spaceId }, { title: 'Synthetic space' })
    await client.createDocument(target, uploadMetadata)
    const upload = {
      operationId: randomUUID(),
      idempotencyKey: randomUUID(),
      expectedGeneration: '1',
      declaredBytes: '4',
      format: 'txt',
    }
    await expect(client.prepareUpload(target, upload)).rejects.toMatchObject({
      problem: { code: 'VERSION_CONFLICT' },
    })
    await expect(
      client.prepareUpload(target, { ...upload, expectedGeneration: '0', declaredBytes: '17' }),
    ).rejects.toMatchObject({ problem: { code: 'QUOTA_EXCEEDED' } })
    const response = await fetch(
      `${service.origin}/api/knowledge/spaces/${target.spaceId}/documents/${target.documentId}/uploads`,
      {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${await tokenFor(fixture.owners[1])}` },
        body: JSON.stringify({ ...upload, expectedGeneration: '0' }),
      },
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', requestId: null })
  })
  await withUploadHttpFixture(async (_fixture, { service, pool, headers }) => {
    const connect = vi.spyOn(pool, 'connect')
    const response = await fetch(
      `${service.origin}/api/knowledge/spaces/${randomUUID()}/documents/${randomUUID()}/uploads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationId: randomUUID(),
          idempotencyKey: randomUUID(),
          expectedGeneration: '0',
          declaredBytes: '4',
          format: 'txt',
        }),
      },
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: 'NOT_CONFIGURED', requestId: null })
    expect(connect).not.toHaveBeenCalled()
    connect.mockRestore()
  }, false)
})
