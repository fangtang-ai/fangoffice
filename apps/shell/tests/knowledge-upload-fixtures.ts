import { vi } from 'vitest'

export function uploadNetwork(spaceId: string, refuseCompletion = false) {
  let documentId = ''
  let title = ''
  return vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input)
    if (options?.method === 'GET') return Response.json({ items: [], nextCursor: null })
    if (options?.method === 'PUT') {
      documentId = url.split('/').at(-1) ?? ''
      title = (JSON.parse(String(options.body)) as { title: string }).title
      return Response.json({
        id: documentId,
        spaceId,
        title,
        tags: [],
        purpose: 'facts',
        generation: '0',
        active: null,
        desired: null,
        deletedAt: null,
      })
    }
    if (url.includes('.aliyuncs.com/')) return new Response(null, { status: 204 })
    const body = JSON.parse(String(options?.body)) as {
      operationId: string
      declaredBytes: string
      expectedGeneration: string
      format: string
    }
    const operation = {
      id: body.operationId,
      spaceId,
      documentId,
      kind: 'upload',
      phase: 'uploading',
      expectedGeneration: body.expectedGeneration,
      targetVersionId: null,
      error: null,
    }
    if (url.endsWith('/uploads/completion'))
      return refuseCompletion
        ? Response.json({ code: 'FORBIDDEN', requestId: null }, { status: 403 })
        : Response.json({
            operation: {
              ...operation,
              phase: 'queued',
              targetVersionId: '019a1234-0000-7000-8000-000000000003',
            },
          })
    if (!url.endsWith('/uploads/authorization')) throw new Error('Unexpected synthetic endpoint')
    return Response.json({
      operation,
      preparation: {
        status: 'prepared',
        maximumBytes: body.declaredBytes,
        format: body.format,
        expiresAt: '2030-10-20T12:15:00.000Z',
      },
      upload: {
        url: 'https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com/',
        expiresAt: '2030-10-20T12:05:00.000Z',
        fields: {
          key: `staging/${'a'.repeat(64)}/${body.operationId}`,
          'Content-Type': 'application/octet-stream',
          'x-oss-signature-version': 'OSS4-HMAC-SHA256',
          'x-oss-credential': 'synthetic-id/20301020/cn-hangzhou/oss/aliyun_v4_request',
          'x-oss-date': '20301020T120000Z',
          'x-oss-security-token': 'synthetic-token',
          'x-oss-forbid-overwrite': 'true',
          'x-oss-object-acl': 'private',
          success_action_status: '204',
          policy: 'eyJzeW50aGV0aWMiOnRydWV9',
          'x-oss-signature': 'a'.repeat(64),
        },
      },
    })
  })
}
