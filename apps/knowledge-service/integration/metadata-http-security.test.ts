import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { expect, it, vi } from 'vitest'
import { uploadMetadata } from './upload-fixtures'
import { withUploadHttpFixture } from './upload-http-fixtures'

it('isolates owner metadata and checks the requested document parent without exposing storage fields', async () => {
  await withUploadHttpFixture(async (fixture, { client, service, headers, tokenFor }) => {
    const target = { spaceId: randomUUID(), documentId: randomUUID() }
    await client.createSpace({ spaceId: target.spaceId }, { title: 'Private space' })
    const document = await client.createDocument(target, uploadMetadata)
    const path = `/api/knowledge/spaces/${target.spaceId}/documents`
    const foreignHeaders = { Authorization: `Bearer ${await tokenFor(fixture.owners[1])}` }
    for (const suffix of [path, `${path}/${target.documentId}`]) {
      const response = await fetch(`${service.origin}${suffix}`, { headers: foreignHeaders })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ code: 'NOT_FOUND', requestId: null })
    }
    const foreignSpaces = await fetch(`${service.origin}/api/knowledge/spaces`, {
      headers: foreignHeaders,
    })
    expect(await foreignSpaces.text()).not.toContain(target.spaceId)
    await expect(client.getDocument({ ...target, spaceId: fixture.id })).rejects.toMatchObject({
      problem: { code: 'NOT_FOUND' },
    })
    const response = await fetch(`${service.origin}${path}/${target.documentId}`, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(document)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

it('rejects forged, duplicate and out-of-bounds read parameters before opening a transaction', async () => {
  await withUploadHttpFixture(async (_fixture, { service, headers, pool }) => {
    const connect = vi.spyOn(pool, 'connect')
    try {
      for (const suffix of [
        '/spaces?ownerId=forged',
        '/spaces?limit=0',
        '/spaces?limit=101',
        '/spaces?limit=01',
        '/spaces?limit=1&limit=2',
        '/spaces?cursor=',
        '/spaces?cursor=forged',
        `/spaces?cursor=${randomUUID()}&cursor=${randomUUID()}`,
        '/spaces?cursor=%27%20OR%201%3D1--',
        '/spaces/not-a-uuid/documents',
        `/spaces/${randomUUID()}/documents?limit=101`,
        `/spaces/${randomUUID()}/documents/${randomUUID()}?ownerId=forged`,
      ]) {
        const response = await fetch(`${service.origin}/api/knowledge${suffix}`, { headers })
        expect(response.status, suffix).toBe(400)
        expect(await response.json()).toEqual({ code: 'INVALID_REQUEST', requestId: null })
      }
      expect(connect).not.toHaveBeenCalled()
    } finally {
      connect.mockRestore()
    }
  })
})

it('reads only the authenticated owner when both owners use identical space and document UUIDs', async () => {
  await withUploadHttpFixture(async (fixture, { client, service, headers, tokenFor }) => {
    const target = { spaceId: randomUUID(), documentId: randomUUID() }
    const space = await client.createSpace({ spaceId: target.spaceId }, { title: 'Own space' })
    const own = await client.createDocument(target, uploadMetadata)
    const foreignHeaders = {
      ...headers,
      Authorization: `Bearer ${await tokenFor(fixture.owners[1])}`,
    }
    const path = `/api/knowledge/spaces/${target.spaceId}`
    for (const [suffix, body] of [
      [path, { title: 'Foreign space' }],
      [`${path}/documents/${target.documentId}`, { ...uploadMetadata, title: 'Foreign document' }],
    ] as const) {
      const response = await fetch(`${service.origin}${suffix}`, {
        method: 'PUT',
        headers: foreignHeaders,
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
    }
    expect((await client.listSpaces()).items).toContainEqual(space)
    expect(await client.getDocument(target)).toEqual(own)
    expect(await client.listDocuments({ spaceId: target.spaceId })).toEqual({
      items: [own],
      nextCursor: null,
    })
    const foreign = await fetch(`${service.origin}${path}/documents/${target.documentId}`, {
      headers: foreignHeaders,
    })
    expect(foreign.status).toBe(200)
    expect(await foreign.json()).toEqual({ ...own, title: 'Foreign document' })
  })
})

it('requires authenticated body-free GET requests and advertises both document methods', async () => {
  await withUploadHttpFixture(async (_fixture, { service, headers, pool }) => {
    const connect = vi.spyOn(pool, 'connect')
    try {
      const list = `${service.origin}/api/knowledge/spaces`
      const document = `${list}/${randomUUID()}/documents/${randomUUID()}`
      expect((await fetch(`${list}?limit=2`)).status).toBe(401)
      expect((await fetch(document)).status).toBe(401)
      const method = await fetch(document, { method: 'POST', headers, body: '{}' })
      expect(method.status).toBe(405)
      expect(method.headers.get('Allow')).toBe('GET, PUT')
      const listMethod = await fetch(list, { method: 'POST', headers, body: '{}' })
      expect(listMethod.status).toBe(405)
      expect(listMethod.headers.get('Allow')).toBe('GET')
      const bodyStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          list,
          { headers: { ...headers, 'Content-Length': '2' } },
          (response) => {
            response.resume()
            response.once('end', () => resolve(response.statusCode))
          },
        )
        request.once('error', reject)
        request.end('{}')
      })
      expect(bodyStatus).toBe(413)
      expect(connect).not.toHaveBeenCalled()
    } finally {
      connect.mockRestore()
    }
  })
})
