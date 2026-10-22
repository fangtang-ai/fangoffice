import { deny } from '../errors'
import { setting, type KnowledgeEnvironment } from './config-values'

export function parseKnowledgeOssUploadConfig(env: KnowledgeEnvironment, now = Date.now()) {
  const keys = [
    'BUCKET',
    'REGION',
    'VERSIONING',
    'ACCESS_KEY_ID',
    'ACCESS_KEY_SECRET',
    'SECURITY_TOKEN',
    'CREDENTIAL_EXPIRES_AT',
  ] as const
  if (keys.every((key) => env[`KNOWLEDGE_UPLOAD_OSS_${key}`] === undefined)) return undefined
  const read = (key: (typeof keys)[number], maximum = 2048) =>
    setting(env[`KNOWLEDGE_UPLOAD_OSS_${key}`], maximum)
  const bucket = read('BUCKET', 63)
  const region = read('REGION', 64)
  const credentialExpiresAt = read('CREDENTIAL_EXPIRES_AT', 24)
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !/^[a-z]{2}(?:-[a-z0-9]+){1,4}$/.test(region) ||
    region.endsWith('-internal') ||
    read('VERSIONING') !== 'disabled' ||
    !Number.isFinite(Date.parse(credentialExpiresAt)) ||
    new Date(credentialExpiresAt).toISOString() !== credentialExpiresAt ||
    Date.parse(credentialExpiresAt) - 60000 <= now
  )
    deny('NOT_CONFIGURED')
  return Object.freeze({
    bucket,
    region,
    credentialExpiresAt,
    accessKeyId: read('ACCESS_KEY_ID', 128),
    accessKeySecret: read('ACCESS_KEY_SECRET'),
    securityToken: read('SECURITY_TOKEN', 8192),
  })
}

export type KnowledgeOssUploadConfig = NonNullable<ReturnType<typeof parseKnowledgeOssUploadConfig>>
