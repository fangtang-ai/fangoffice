import type { IncomingMessage, ServerResponse } from 'node:http'
import { KnowledgePolicyError } from '../errors'
import type { KnowledgeDatabase } from './database'
import type { createKnowledgeAuthenticator } from './authentication'

function respond(response: ServerResponse, status: number, body: object) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
    ...(status === 405 ? { Allow: 'GET' } : {}),
  })
  response.end(JSON.stringify(body))
}

export function knowledgeHttpHandler(
  database: KnowledgeDatabase,
  authenticate: ReturnType<typeof createKnowledgeAuthenticator>,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const error = (status: number, code: string) =>
      respond(response, status, { code, requestId: null })
    try {
      if (
        request.headers['transfer-encoding'] ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0')
      ) {
        error(413, 'INVALID_REQUEST')
        return
      }
      if (request.method !== 'GET') {
        error(405, 'INVALID_REQUEST')
        return
      }
      if (request.url === '/healthz') {
        respond(response, 200, { status: 'ok' })
        return
      }
      if (!database.healthy()) {
        error(503, 'SERVICE_UNAVAILABLE')
        return
      }
      if (request.url === '/readyz') {
        respond(response, 200, { status: 'ready' })
        return
      }
      if (!request.url?.startsWith('/api/knowledge/')) {
        error(404, 'NOT_FOUND')
        return
      }
      if (request.headersDistinct.authorization?.length !== 1) {
        error(401, 'UNAUTHENTICATED')
        return
      }
      await authenticate(request.headers.authorization)
      if (!database.healthy()) {
        error(503, 'SERVICE_UNAVAILABLE')
        return
      }
      if (request.url === '/api/knowledge/status') respond(response, 200, { status: 'ready' })
      else error(404, 'NOT_FOUND')
    } catch (failure) {
      if (failure instanceof KnowledgePolicyError && failure.code === 'UNAUTHENTICATED')
        error(401, 'UNAUTHENTICATED')
      else error(503, 'SERVICE_UNAVAILABLE')
    }
  }
}
