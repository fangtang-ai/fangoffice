import type { IncomingMessage, ServerResponse } from 'node:http'
import { KnowledgePolicyError } from '../errors'
import type { KnowledgeDeletionWriter } from '../deletion/intent'
import type { createKnowledgeAuthenticator } from './authentication'
import type { KnowledgeDatabase } from './database'
import { applyKnowledgeDeletionIntent, deleteKnowledgeScope } from './deletion'
import { readKnowledgeJsonBody } from './http-body'
import { handleKnowledgeUpload, knowledgeUploadRoute } from './upload-http'
import { handleKnowledgeMetadataRead, knowledgeMetadataReadRoute } from './metadata-http'
import type { KnowledgeUploadPolicy } from './upload-preparation'
import type { KnowledgeOssUploadConfig } from './oss-upload-config'

const maximumDeletionRequestBytes = 4096
const maximumMetadataRequestBytes = 16384

export interface KnowledgeHttpHandlerOptions {
  now?: () => number
  uploadPolicy?: KnowledgeUploadPolicy
  uploadAuthorization?: KnowledgeOssUploadConfig
}

function respond(response: ServerResponse, status: number, body: object, allow?: string) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
    ...(status === 405 ? { Allow: allow ?? 'GET' } : {}),
  })
  response.end(JSON.stringify(body))
}

export function knowledgeHttpHandler(
  database: KnowledgeDatabase,
  authenticate: ReturnType<typeof createKnowledgeAuthenticator>,
  journal: KnowledgeDeletionWriter,
  { now, uploadPolicy, uploadAuthorization }: KnowledgeHttpHandlerOptions = {},
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const error = (status: number, code: string, allow?: string) =>
      respond(response, status, { code, requestId: null }, allow)
    try {
      const method = request.method ?? ''
      const readRoute = knowledgeMetadataReadRoute(request.url)
      const writeRoute = knowledgeUploadRoute(request.url)
      const allowedMethods = [
        ...(readRoute ? ['GET'] : []),
        ...(writeRoute ? [writeRoute.method] : []),
      ]
      if (allowedMethods.length > 0 && !allowedMethods.includes(method))
        return error(405, 'INVALID_REQUEST', allowedMethods.join(', '))
      // A shared document path must select the method before applying write-only body requirements.
      const uploadRoute = method === writeRoute?.method ? writeRoute : null
      const contentLength = request.headers['content-length']
      if (method === 'DELETE' || uploadRoute) {
        const maximumBytes = uploadRoute ? maximumMetadataRequestBytes : maximumDeletionRequestBytes
        if (
          typeof contentLength === 'string' &&
          /^\d+$/.test(contentLength) &&
          (contentLength.length > 5 || Number(contentLength) > maximumBytes)
        )
          return error(413, 'INVALID_REQUEST')
        if (
          request.headers['transfer-encoding'] ||
          typeof contentLength !== 'string' ||
          !/^[1-9]\d{0,4}$/.test(contentLength) ||
          (uploadRoute &&
            (request.headersDistinct['content-type']?.length !== 1 ||
              !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
                request.headers['content-type'] ?? '',
              ) ||
              request.headers['content-encoding'] !== undefined))
        )
          return error(400, 'INVALID_REQUEST')
      } else if (
        request.headers['transfer-encoding'] ||
        (contentLength !== undefined && contentLength !== '0')
      ) {
        return error(413, 'INVALID_REQUEST')
      }
      if (!uploadRoute && method !== 'GET' && method !== 'DELETE') {
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
      const principal = await authenticate(request.headers.authorization)
      if (!database.healthy()) {
        error(503, 'SERVICE_UNAVAILABLE')
        return
      }
      if (request.url === '/api/knowledge/status') {
        respond(response, 200, { status: 'ready' })
        return
      }
      if (readRoute && method === 'GET') {
        const outcome = await handleKnowledgeMetadataRead(database, principal, readRoute, now)
        respond(response, 200, outcome)
        return
      }
      if (uploadRoute) {
        const body = await readKnowledgeJsonBody(request, maximumMetadataRequestBytes)
        const outcome = await handleKnowledgeUpload(
          database,
          principal,
          uploadRoute,
          body,
          uploadPolicy,
          now,
          uploadAuthorization,
        )
        respond(response, 200, outcome)
        return
      }
      if (request.url === '/api/knowledge/deletions') {
        if (method !== 'DELETE') {
          error(405, 'INVALID_REQUEST', 'DELETE')
          return
        }
        const parsed = await readKnowledgeJsonBody(request, maximumDeletionRequestBytes)
        const outcome = await deleteKnowledgeScope(
          principal,
          parsed,
          journal,
          (intent) =>
            database.transaction(
              principal,
              (transaction) => applyKnowledgeDeletionIntent(transaction, intent),
              { now },
            ),
          { now },
        )
        respond(response, 200, { intentId: outcome.intentId, phase: outcome.phase })
        return
      }
      error(404, 'NOT_FOUND')
    } catch (failure) {
      if (failure instanceof KnowledgePolicyError) {
        if (failure.code === 'UNAUTHENTICATED') return error(401, 'UNAUTHENTICATED')
        if (failure.code === 'INVALID_REQUEST') return error(400, 'INVALID_REQUEST')
        if (failure.code === 'NOT_FOUND') return error(404, 'NOT_FOUND')
        if (failure.code === 'FORBIDDEN') return error(403, 'FORBIDDEN')
        if (failure.code === 'VERSION_CONFLICT' || failure.code === 'QUOTA_EXCEEDED')
          return error(409, failure.code)
        if (failure.code === 'NOT_CONFIGURED') return error(503, 'NOT_CONFIGURED')
      }
      error(503, 'SERVICE_UNAVAILABLE')
    }
  }
}
