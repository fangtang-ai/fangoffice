import { createHash, createHmac } from 'node:crypto'
import { deny } from '../errors'
import { parseKnowledgeOssUploadConfig, type KnowledgeOssUploadConfig } from './oss-upload-config'

export function createOssSourceRequest(
  settings: KnowledgeOssUploadConfig,
  now: () => number,
  fetch: typeof globalThis.fetch,
) {
  const config = parseKnowledgeOssUploadConfig(
    {
      KNOWLEDGE_UPLOAD_OSS_BUCKET: settings.bucket,
      KNOWLEDGE_UPLOAD_OSS_REGION: settings.region,
      KNOWLEDGE_UPLOAD_OSS_VERSIONING: 'disabled',
      KNOWLEDGE_UPLOAD_OSS_ACCESS_KEY_ID: settings.accessKeyId,
      KNOWLEDGE_UPLOAD_OSS_ACCESS_KEY_SECRET: settings.accessKeySecret,
      KNOWLEDGE_UPLOAD_OSS_SECURITY_TOKEN: settings.securityToken,
      KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: settings.credentialExpiresAt,
    },
    now(),
  )!
  return async (
    method: 'GET' | 'PUT',
    key: string,
    signal: AbortSignal,
    extra: Record<string, string> = {},
  ) => {
    if (signal.aborted) deny('CANCELLED')
    const current = now()
    if (!Number.isFinite(current) || Date.parse(config.credentialExpiresAt) - 60_000 <= current)
      deny('NOT_CONFIGURED')
    const url = `https://${config.bucket}.oss-${config.region}.aliyuncs.com/${key}`
    let response: Response
    try {
      response = await fetch(url, {
        method,
        redirect: 'error',
        signal,
        headers: signedHeaders(config, method, key, current, extra),
      })
    } catch {
      if (signal.aborted) deny('CANCELLED')
      deny('SERVICE_UNAVAILABLE')
    }
    // 非协作transport可能在取消后才返回；交出流前清理，且绝不接受跨源重定向。
    if (signal.aborted || response.redirected || (response.url !== '' && response.url !== url)) {
      await response.body?.cancel().catch(() => undefined)
      if (signal.aborted) deny('CANCELLED')
      deny('SERVICE_UNAVAILABLE')
    }
    return response
  }
}

function signedHeaders(
  config: KnowledgeOssUploadConfig,
  method: string,
  key: string,
  now: number,
  extra: Record<string, string>,
) {
  const dateTime = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, '')
  const date = dateTime.slice(0, 8)
  const scope = `${date}/${config.region}/oss/aliyun_v4_request`
  const headers: Record<string, string> = {
    'accept-encoding': 'identity',
    'x-oss-date': dateTime,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-security-token': config.securityToken,
    ...extra,
  }
  // OSS规范URI包含桶名；默认签名所有x-oss-*及Content-Type，空AdditionalHeaders仍占一行。
  const canonicalHeaders = Object.keys(headers)
    .filter((name) => name.startsWith('x-oss-') || name === 'content-type')
    .sort()
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join('')
  const canonical = `${method}\n/${config.bucket}/${key}\n\n${canonicalHeaders}\n\nUNSIGNED-PAYLOAD`
  const toSign = `OSS4-HMAC-SHA256\n${dateTime}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`
  const hmac = (secret: string | Buffer, value: string) =>
    createHmac('sha256', secret).update(value).digest()
  const signingKey = hmac(
    hmac(hmac(hmac(`aliyun_v4${config.accessKeySecret}`, date), config.region), 'oss'),
    'aliyun_v4_request',
  )
  headers.authorization = `OSS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope},Signature=${hmac(signingKey, toSign).toString('hex')}`
  return headers
}
