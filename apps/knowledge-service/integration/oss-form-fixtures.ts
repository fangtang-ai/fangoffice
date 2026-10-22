import { createHmac } from 'node:crypto'
import { createServer, get, type IncomingMessage } from 'node:http'
import { expect, vi } from 'vitest'

export async function syntheticOssFormTarget(accountOrigin: string) {
  const origin = 'https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com/'
  const objects = new Map<string, Uint8Array>()
  const accountHeaders: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      const key = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('key')
      const bytes = key ? objects.get(key) : undefined
      if (!bytes) return response.writeHead(404).end()
      return response
        .writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.byteLength.toString(),
          ETag: '"synthetic-object-revision"',
        })
        .end(bytes)
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65536) request.destroy()
      else chunks.push(chunk)
    })
    request.on('error', () => response.destroy())
    request.on('end', () => {
      void (async () => {
        accountHeaders.push(request.headers.authorization ?? request.headers.cookie ?? '')
        const body = new Response(new Uint8Array(Buffer.concat(chunks)), {
          headers: { 'Content-Type': request.headers['content-type'] ?? '' },
        })
        const form = await body.formData()
        const file = form.get('file')
        if (!(file instanceof Blob)) throw new Error('Missing synthetic file')
        const value = (key: string) => {
          const entry = form.get(key)
          if (typeof entry !== 'string' || form.getAll(key).length !== 1)
            throw new Error('Invalid synthetic field')
          return entry
        }
        const policy = JSON.parse(Buffer.from(value('policy'), 'base64').toString('utf8')) as {
          expiration: string
          conditions: unknown[]
        }
        expect(Date.parse(policy.expiration)).toBeGreaterThan(Date.now())
        expect(policy.conditions).toContainEqual({ bucket: 'synthetic-private-knowledge' })
        expect(policy.conditions).toContainEqual(['content-length-range', file.size, file.size])
        for (const [key, entry] of form) {
          if (['file', 'policy', 'x-oss-signature'].includes(key)) continue
          expect(policy.conditions).toContainEqual(['eq', `$${key}`, entry])
        }
        expect(value('x-oss-object-acl')).toBe('private')
        expect(value('x-oss-forbid-overwrite')).toBe('true')
        const [, date, region] = value('x-oss-credential').split('/')
        expect(region).toBe('cn-hangzhou')
        let signingKey = Buffer.from('aliyun_v4synthetic-sts-secret')
        for (const scope of [date!, region!, 'oss', 'aliyun_v4_request'])
          signingKey = createHmac('sha256', signingKey).update(scope).digest()
        expect(value('x-oss-signature')).toBe(
          createHmac('sha256', signingKey).update(value('policy')).digest('hex'),
        )
        const key = value('key')
        if (objects.has(key)) return response.writeHead(409).end()
        objects.set(key, new Uint8Array(await file.arrayBuffer()))
        response.writeHead(204).end()
      })().catch(() => response.writeHead(403).end())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing synthetic HTTP port')
  const localOrigin = `http://127.0.0.1:${address.port}/`
  const nativeFetch = globalThis.fetch
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === origin) {
      const response = await nativeFetch(localOrigin, init)
      return new Response(response.body, { status: response.status, headers: response.headers })
    }
    if (!String(input).startsWith(`${accountOrigin}/`))
      throw new Error('Refusing a non-synthetic network target')
    return nativeFetch(input, init)
  })
  return {
    objects,
    accountHeaders,
    async readObject(key: string) {
      const body = await new Promise<IncomingMessage>((resolve, reject) => {
        get(`${localOrigin}?key=${encodeURIComponent(key)}`, resolve).on('error', reject)
      })
      const contentLength = body.headers['content-length']
      const contentType = body.headers['content-type']
      const etag = body.headers.etag
      if (
        body.statusCode !== 200 ||
        !contentLength ||
        !/^[1-9]\d*$/.test(contentLength) ||
        !contentType ||
        !etag
      ) {
        body.destroy()
        throw new Error('Invalid synthetic object response')
      }
      return { key, etag, contentType, contentLength: BigInt(contentLength), body }
    },
    async close() {
      network.mockRestore()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
