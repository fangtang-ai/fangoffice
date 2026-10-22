import { createHmac } from 'node:crypto'
import { deny } from '../errors'
import type { KnowledgeOssUploadConfig } from './oss-upload-config'
import type { prepareKnowledgeUpload } from './upload-preparation'

export function authorizeKnowledgeOssUpload(
  config: KnowledgeOssUploadConfig,
  prepared: Awaited<ReturnType<typeof prepareKnowledgeUpload>>,
  now = Date.now(),
) {
  const { staging, operation } = prepared
  const credentialDeadline = Date.parse(config.credentialExpiresAt) - 60_000
  if (!Number.isFinite(now) || !Number.isFinite(credentialDeadline) || credentialDeadline <= now)
    deny('NOT_CONFIGURED')
  const bytes = staging.maximumBytes
  const sessionDeadline = Date.parse(staging.expiresAt)
  if (
    operation.kind !== 'upload' ||
    operation.phase !== 'uploading' ||
    !/^[1-9]\d{0,18}$/.test(bytes) ||
    BigInt(bytes) > 5_000_000_000n ||
    !/^staging\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(staging.key) ||
    staging.key.split('/').at(-1) !== operation.id ||
    !Number.isFinite(sessionDeadline) ||
    sessionDeadline <= now
  )
    deny('VERSION_CONFLICT')
  const expiresAt = new Date(
    Math.min(now + 300_000, sessionDeadline, credentialDeadline),
  ).toISOString()
  const dateTime = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, '')
  const date = dateTime.slice(0, 8)
  const fields = {
    key: staging.key,
    'Content-Type': 'application/octet-stream',
    'x-oss-signature-version': 'OSS4-HMAC-SHA256' as const,
    'x-oss-credential': `${config.accessKeyId}/${date}/${config.region}/oss/aliyun_v4_request`,
    'x-oss-date': dateTime,
    'x-oss-security-token': config.securityToken,
    'x-oss-forbid-overwrite': 'true' as const,
    'x-oss-object-acl': 'private' as const,
    success_action_status: '204' as const,
  }
  // POST策略同时锁定对象、大小、私有ACL与禁止覆盖；桶须禁用版本化，否则OSS会忽略禁止覆盖。
  const policy = Buffer.from(
    JSON.stringify({
      expiration: expiresAt,
      conditions: [
        { bucket: config.bucket },
        ['eq', '$key', fields.key],
        ['content-length-range', Number(bytes), Number(bytes)],
        ...Object.entries(fields)
          .filter(([key]) => key !== 'key')
          .map(([key, value]) => ['eq', `$${key}`, value]),
      ],
    }),
  ).toString('base64')
  const hmac = (key: string | Buffer, value: string) =>
    createHmac('sha256', key).update(value).digest()
  // OSS V4签名直接覆盖base64策略，派生密钥按日期→区域→oss→aliyun_v4_request，不套用S3前缀。
  const signingKey = hmac(
    hmac(hmac(hmac(`aliyun_v4${config.accessKeySecret}`, date), config.region), 'oss'),
    'aliyun_v4_request',
  )
  return {
    url: `https://${config.bucket}.oss-${config.region}.aliyuncs.com/`,
    expiresAt,
    fields: { ...fields, policy, 'x-oss-signature': hmac(signingKey, policy).toString('hex') },
  }
}
