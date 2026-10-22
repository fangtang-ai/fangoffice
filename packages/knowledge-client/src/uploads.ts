import {
  KnowledgeContractError,
  parseKnowledgeDocumentTarget,
  parseKnowledgeUploadAuthorization,
  parseKnowledgeUploadRequest,
} from '@genoffice/knowledge-contract'
import { KnowledgeClientError } from './errors'
import { createRequestLifetime } from './lifetime'
import { cancelResponse } from './response'
import { bindAccount } from './session'
import type { createKnowledgeTransport } from './transport'
import type { KnowledgeAccountAccess, KnowledgeRequestOptions } from './types'

export function createKnowledgeUploads(
  request: ReturnType<typeof createKnowledgeTransport>,
  access: KnowledgeAccountAccess,
  closed: AbortSignal,
  timeoutMs: number,
) {
  const authorizeUpload = async (
    targetInput: unknown,
    declaration: unknown,
    options: KnowledgeRequestOptions = {},
  ) => {
    const target = parseKnowledgeDocumentTarget(targetInput)
    const body = parseKnowledgeUploadRequest(declaration)
    return request(
      `/spaces/${target.spaceId}/documents/${target.documentId}/uploads/authorization`,
      (value) => parseKnowledgeUploadAuthorization(value, target, body),
      options,
      { method: 'POST', body },
    )
  }
  return {
    authorizeUpload,
    async uploadFile(
      targetInput: unknown,
      declaration: unknown,
      content: Blob,
      options: KnowledgeRequestOptions = {},
    ) {
      const target = parseKnowledgeDocumentTarget(targetInput)
      const body = parseKnowledgeUploadRequest(declaration)
      if (
        !(content instanceof Blob) ||
        !Number.isSafeInteger(content.size) ||
        BigInt(content.size).toString() !== body.declaredBytes
      )
        throw new KnowledgeContractError('uploadFile.content')
      if (closed.aborted) throw new KnowledgeClientError('knowledge:closed')
      const lifetime = createRequestLifetime(
        access,
        bindAccount(access),
        closed,
        options.signal,
        timeoutMs,
      )
      return lifetime.run(async () => {
        try {
          const grant = await authorizeUpload(target, body, { signal: lifetime.signal })
          lifetime.check()
          if (Date.parse(grant.upload.expiresAt) <= Date.now())
            throw new KnowledgeClientError('knowledge:request-failed')
          const form = new FormData()
          for (const [key, value] of Object.entries(grant.upload.fields)) form.set(key, value)
          // 对象请求不复用账号transport/headers；file必须最后，边界由原生FormData生成。
          form.set('file', content, 'upload.bin')
          const response = await globalThis.fetch(grant.upload.url, {
            method: 'POST',
            body: form,
            credentials: 'omit',
            redirect: 'error',
            signal: lifetime.signal,
            referrerPolicy: 'no-referrer',
          })
          cancelResponse(response)
          lifetime.check()
          if (response.redirected || (response.url && response.url !== grant.upload.url))
            throw new KnowledgeClientError('knowledge:untrusted-target')
          if (response.status !== 204) throw new KnowledgeClientError('knowledge:request-failed')
          return {
            operation: grant.operation,
            preparation: grant.preparation,
            transfer: { status: 'uploaded_to_staging' as const },
          }
        } catch (error) {
          lifetime.check()
          if (error instanceof KnowledgeClientError) throw error
          throw new KnowledgeClientError('knowledge:request-failed')
        }
      })
    },
  }
}
