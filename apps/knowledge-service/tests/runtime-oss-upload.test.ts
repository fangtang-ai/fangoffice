import { expect, it } from 'vitest'
import { authorizeKnowledgeOssUpload, parseKnowledgeOssUploadConfig } from '../src/runtime'
import { ossUploadEnvironment, ossUploadNow, ossUploadPrepared } from './oss-upload-fixtures'

it('signs a short-lived STS policy for one private immutable object and exact declared bytes', () => {
  const config = parseKnowledgeOssUploadConfig(ossUploadEnvironment, ossUploadNow)!
  const grant = authorizeKnowledgeOssUpload(config, ossUploadPrepared, ossUploadNow)
  expect(grant.url).toBe('https://synthetic-private-knowledge.oss-cn-hangzhou.aliyuncs.com/')
  expect(grant.expiresAt).toBe('2026-10-20T12:05:00.000Z')
  expect(grant.fields).toMatchObject({
    key: ossUploadPrepared.staging.key,
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
    'x-oss-credential': 'synthetic-sts-id/20261020/cn-hangzhou/oss/aliyun_v4_request',
    'x-oss-date': '20261020T120000Z',
    'x-oss-security-token': 'synthetic-sts-token',
    'x-oss-forbid-overwrite': 'true',
    'x-oss-object-acl': 'private',
    'Content-Type': 'application/octet-stream',
    success_action_status: '204',
  })
  const policy: { expiration: string; conditions: unknown[] } = JSON.parse(
    Buffer.from(grant.fields.policy, 'base64').toString('utf8'),
  )
  expect(policy).toEqual({
    expiration: grant.expiresAt,
    conditions: [
      { bucket: 'synthetic-private-knowledge' },
      ['eq', '$key', ossUploadPrepared.staging.key],
      ['content-length-range', 4, 4],
      ...Object.entries(grant.fields)
        .filter(([key]) => !['key', 'policy', 'x-oss-signature'].includes(key))
        .map(([key, value]) => ['eq', `$${key}`, value]),
    ],
  })
  expect(JSON.stringify(grant)).not.toContain('synthetic-sts-secret')
  expect(grant.fields['x-oss-signature']).toBe(
    'e6344ad6d00937eb5cb4220a62b3689f492f3932dbd2d4ad86c576fae973e36a',
  )
})

it('never extends a session or credential deadline and refuses an expired or malformed fact', () => {
  const config = parseKnowledgeOssUploadConfig(ossUploadEnvironment, ossUploadNow)!
  const nearExpiry = {
    ...ossUploadPrepared,
    staging: { ...ossUploadPrepared.staging, expiresAt: '2026-10-20T12:00:30.000Z' },
  }
  expect(authorizeKnowledgeOssUpload(config, nearExpiry, ossUploadNow).expiresAt).toBe(
    '2026-10-20T12:00:30.000Z',
  )
  expect(
    authorizeKnowledgeOssUpload(
      { ...config, credentialExpiresAt: '2026-10-20T12:01:30.000Z' },
      ossUploadPrepared,
      ossUploadNow,
    ).expiresAt,
  ).toBe('2026-10-20T12:00:30.000Z')
  for (const staging of [
    { ...ossUploadPrepared.staging, expiresAt: '2026-10-20T12:00:00.000Z' },
    { ...ossUploadPrepared.staging, maximumBytes: '5000000001' },
    { ...ossUploadPrepared.staging, key: 'staging/other-owner/forged' },
  ]) {
    expect(() =>
      authorizeKnowledgeOssUpload(config, { ...ossUploadPrepared, staging }, ossUploadNow),
    ).toThrow()
  }
  expect(() =>
    authorizeKnowledgeOssUpload(
      { ...config, credentialExpiresAt: '2026-10-20T12:00:30.000Z' },
      ossUploadPrepared,
      ossUploadNow,
    ),
  ).toThrow('NOT_CONFIGURED')
})

it('fails closed for partial credentials, custom endpoints or an overwrite-unsafe bucket mode', () => {
  expect(parseKnowledgeOssUploadConfig({})).toBeUndefined()
  for (const override of [
    { KNOWLEDGE_UPLOAD_OSS_BUCKET: '../forged' },
    { KNOWLEDGE_UPLOAD_OSS_REGION: 'cn-hangzhou-internal' },
    { KNOWLEDGE_UPLOAD_OSS_VERSIONING: 'enabled' },
    { KNOWLEDGE_UPLOAD_OSS_SECURITY_TOKEN: '' },
    { KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: 'invalid' },
    { KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: '2026-10-20T11:59:00.000Z' },
  ]) {
    expect(() =>
      parseKnowledgeOssUploadConfig({ ...ossUploadEnvironment, ...override }, ossUploadNow),
    ).toThrow('NOT_CONFIGURED')
  }
  expect(() => parseKnowledgeOssUploadConfig({ KNOWLEDGE_UPLOAD_OSS_BUCKET: 'synthetic' })).toThrow(
    'NOT_CONFIGURED',
  )
})
