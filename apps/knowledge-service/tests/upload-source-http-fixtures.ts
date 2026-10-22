import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import type { KnowledgeSourceStore } from '../src/runtime'
import { textUploadInput } from './upload-verification-fixtures'

export async function sourceHttpFixture() {
  const input = textUploadInput([Buffer.from('test')])
  const objects = new Map([
    [
      input.object.key,
      {
        bytes: Buffer.from('test'),
        etag: input.object.etag,
        mimeType: 'application/octet-stream',
      },
    ],
  ])
  const requests: {
    method: string
    key: string
    headers: Record<string, string | string[] | undefined>
  }[] = []
  const server = createServer((request, response) => {
    const key = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname.slice(1))
    requests.push({ method: request.method!, key, headers: request.headers })
    if (request.method === 'PUT') {
      const headers = request.headers
      const source = objects.get(
        String(headers['x-oss-copy-source']).replace('/synthetic-private-knowledge/', ''),
      )
      if (
        headers['x-oss-forbid-overwrite'] !== 'true' ||
        headers['x-oss-object-acl'] !== 'private' ||
        headers['x-oss-metadata-directive'] !== 'REPLACE' ||
        headers['content-type'] !== 'text/plain'
      ) {
        response.writeHead(400).end()
      } else if (!source || source.etag !== headers['x-oss-copy-source-if-match']) {
        response.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>')
      } else if (objects.has(key)) {
        response.writeHead(409).end('<Error><Code>FileAlreadyExists</Code></Error>')
      } else {
        objects.set(key, {
          bytes: Buffer.from(source.bytes),
          etag: '"target-http-revision"',
          mimeType: 'text/plain',
        })
        response
          .writeHead(200)
          .end(
            '<CopyObjectResult><ETag>"target-http-revision"</ETag><LastModified>2026-10-20T12:00:00.000Z</LastModified></CopyObjectResult>',
          )
      }
      return
    }
    const object = objects.get(key)
    if (request.method !== 'GET' || !object) {
      response.writeHead(404).end()
      return
    }
    response
      .writeHead(200, {
        'content-length': object.bytes.byteLength,
        'content-type': object.mimeType,
        etag: object.etag,
      })
      .end(object.bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('synthetic server unavailable')
  const base = `http://127.0.0.1:${address.port}/`
  const store: KnowledgeSourceStore = {
    async copy(request) {
      const response = await fetch(`${base}${encodeURIComponent(request.key)}`, {
        method: 'PUT',
        signal: request.signal,
        headers: {
          'x-oss-copy-source': `/synthetic-private-knowledge/${request.sourceKey}`,
          'x-oss-copy-source-if-match': request.sourceEtag,
          'x-oss-forbid-overwrite': String(request.forbidOverwrite),
          'x-oss-object-acl': request.privateAcl ? 'private' : 'public-read',
          'x-oss-metadata-directive': request.replaceMetadata ? 'REPLACE' : 'COPY',
          'content-type': request.mimeType,
        },
      })
      await response.arrayBuffer()
      if (response.status === 200) return 'copied'
      if (response.status === 409) return 'exists'
      if (response.status === 412) return 'source_changed'
      throw new Error('synthetic copy failed')
    },
    async read({ key, signal }) {
      const response = await fetch(`${base}${encodeURIComponent(key)}`, { signal })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('synthetic object unavailable')
      }
      return {
        key,
        etag: response.headers.get('etag')!,
        contentLength: BigInt(response.headers.get('content-length')!),
        contentType: response.headers.get('content-type')!,
        body: Readable.fromWeb(response.body),
      }
    },
  }
  return {
    objects,
    requests,
    store,
    async fetch(url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) {
      const target = new URL(String(url))
      if (target.origin !== 'https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com')
        throw new Error('synthetic transport refuses unexpected endpoint')
      const response = await fetch(new URL(target.pathname, base), options)
      return new Response(response.body, { status: response.status, headers: response.headers })
    },
    async input() {
      const fresh = textUploadInput([Buffer.from('test')])
      fresh.object = await store.read({
        key: fresh.object.key,
        signal: new AbortController().signal,
      })
      return fresh
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
