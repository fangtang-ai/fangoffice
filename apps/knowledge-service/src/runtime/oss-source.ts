import { Readable } from 'node:stream'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { deny, KnowledgePolicyError } from '../errors'
import type { KnowledgeOssUploadConfig } from './oss-upload-config'
import type { KnowledgeSourceStore } from './upload-source'
import type { KnowledgeImdsCredentialSource } from './imds-credentials'
import { createOssSourceRequest } from './oss-source-request'

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const objectKey = new RegExp(
  `^(?:staging/[a-f0-9]{64}/${uuid}|originals/[a-f0-9]{64}/${uuid}/${uuid})$`,
)

export function createKnowledgeOssSourceStore(
  settings: KnowledgeOssUploadConfig,
  {
    now = Date.now,
    fetch = globalThis.fetch,
  }: { now?: () => number; fetch?: typeof globalThis.fetch } = {},
) {
  const bucket = settings.bucket
  const request = createOssSourceRequest(settings, now, fetch)
  return {
    async read({ key, signal }) {
      return readVia(request, key, signal)
    },
    async copy(input) {
      const { sourceKey, sourceEtag, key, mimeType, signal } = input
      const source = sourceKey.split('/')
      const target = key.split('/')
      if (
        !objectKey.test(key) ||
        !objectKey.test(sourceKey) ||
        source[0] !== 'staging' ||
        target[0] !== 'originals' ||
        source[1] !== target[1] ||
        source[2] !== target[3] ||
        !/^[\x21-\x7e]{1,256}$/.test(sourceEtag) ||
        !['text/plain', 'text/markdown'].includes(mimeType) ||
        input.forbidOverwrite !== true ||
        input.privateAcl !== true ||
        input.replaceMetadata !== true
      )
        deny('INVALID_REQUEST')
      const response = await request('PUT', key, signal, {
        'x-oss-copy-source': `/${bucket}/${sourceKey}`,
        'x-oss-copy-source-if-match': sourceEtag,
        'x-oss-forbid-overwrite': 'true',
        'x-oss-object-acl': 'private',
        'x-oss-metadata-directive': 'REPLACE',
        'content-type': mimeType,
      })
      return copyResult(response, signal)
    },
  } satisfies KnowledgeSourceStore
}

// 每次读取前从 IMDS 凭证源取最新STS临时凭证并重新签名；桶来自版本行，region 来自 worker 配置。
export function createKnowledgeImdsOssSourceStore(
  settings: { region: string },
  credentialSource: KnowledgeImdsCredentialSource,
  { now = Date.now, fetch = globalThis.fetch }: { now?: () => number; fetch?: typeof globalThis.fetch } = {},
) {
  return {
    async read(input: { bucket: string; key: string; signal: AbortSignal }) {
      if (!objectKey.test(input.key)) deny('INVALID_REQUEST')
      const credentials = await credentialSource.get()
      const request = createOssSourceRequest(
        {
          bucket: input.bucket,
          region: settings.region,
          // IMDS回包是秒级ISO时间，需规范化成 toISOString 形态才能过配置校验。
          credentialExpiresAt: new Date(credentials.expiresAt).toISOString(),
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.accessKeySecret,
          securityToken: credentials.securityToken,
        },
        now,
        fetch,
      )!
      return readVia(request, input.key, input.signal)
    },
  }
}

async function readVia(
  request: (method: 'GET' | 'PUT', key: string, signal: AbortSignal, extra?: Record<string, string>) => Promise<Response>,
  key: string,
  signal: AbortSignal,
) {
  if (!objectKey.test(key)) deny('INVALID_REQUEST')
  const response = await request('GET', key, signal)
  try {
    const length = response.headers.get('content-length') ?? ''
    const etag = response.headers.get('etag') ?? ''
    const contentType = response.headers.get('content-type') ?? ''
    if (
      response.status !== 200 ||
      !response.body ||
      !/^(?:0|[1-9]\d{0,18})$/.test(length) ||
      BigInt(length) > 9223372036854775807n ||
      !/^[\x21-\x7e]{1,256}$/.test(etag) ||
      !contentType ||
      response.headers.has('content-range') ||
      ![null, 'identity'].includes(response.headers.get('content-encoding')) ||
      ![null, 'null'].includes(response.headers.get('x-oss-version-id')) ||
      ![null, 'Normal'].includes(response.headers.get('x-oss-object-type'))
    )
      deny('SERVICE_UNAVAILABLE')
    return {
      key,
      etag,
      contentType,
      contentLength: BigInt(length),
      body: Readable.fromWeb(response.body, { signal }),
    }
  } catch (error) {
    await response.body?.cancel().catch(() => undefined)
    if (error instanceof KnowledgePolicyError) throw error
    deny('SERVICE_UNAVAILABLE')
  }
}

async function copyResult(response: Response, signal: AbortSignal) {
  if (!response.body) deny('SERVICE_UNAVAILABLE')
  const body = Readable.fromWeb(response.body, { signal })
  try {
    const chunks: Buffer[] = []
    let size = 0
    const source: AsyncIterable<unknown> = body
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) deny('SERVICE_UNAVAILABLE')
      size += chunk.byteLength
      if (size > 16384) deny('SERVICE_UNAVAILABLE')
      chunks.push(Buffer.from(chunk))
    }
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true)
      deny('SERVICE_UNAVAILABLE')
    const parsed: unknown = new XMLParser({
      parseTagValue: false,
      processEntities: false,
      ignoreDeclaration: true,
    }).parse(xml)
    const root = xmlRecord(parsed)
    const result = xmlRecord(root?.CopyObjectResult)
    const error = xmlRecord(root?.Error)
    // 200也必须有合法CopyObjectResult，409只接受禁止覆盖的明确错误，不把保留策略冲突当成功。
    if (
      response.status === 200 &&
      !error &&
      result &&
      typeof result.ETag === 'string' &&
      /^[\x21-\x7e]{1,256}$/.test(result.ETag) &&
      typeof result.LastModified === 'string' &&
      Number.isFinite(Date.parse(result.LastModified)) &&
      [null, 'null'].includes(response.headers.get('x-oss-version-id')) &&
      [null, 'null'].includes(response.headers.get('x-oss-copy-source-version-id'))
    )
      return 'copied' as const
    if (response.status === 409 && error?.Code === 'FileAlreadyExists') return 'exists' as const
    if (response.status === 412 && error?.Code === 'PreconditionFailed')
      return 'source_changed' as const
    deny('SERVICE_UNAVAILABLE')
  } catch {
    deny('SERVICE_UNAVAILABLE')
  } finally {
    body.destroy()
  }
}

function xmlRecord(input: unknown) {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}
