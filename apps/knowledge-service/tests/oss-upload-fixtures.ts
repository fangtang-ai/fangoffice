export const ossUploadNow = Date.parse('2026-10-20T12:00:00.000Z')
export const ossUploadEnvironment = {
  KNOWLEDGE_UPLOAD_OSS_BUCKET: 'synthetic-private-knowledge',
  KNOWLEDGE_UPLOAD_OSS_REGION: 'cn-hangzhou',
  KNOWLEDGE_UPLOAD_OSS_VERSIONING: 'disabled',
  KNOWLEDGE_UPLOAD_OSS_ACCESS_KEY_ID: 'synthetic-sts-id',
  KNOWLEDGE_UPLOAD_OSS_ACCESS_KEY_SECRET: 'synthetic-sts-secret',
  KNOWLEDGE_UPLOAD_OSS_SECURITY_TOKEN: 'synthetic-sts-token',
  KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: '2026-10-20T13:00:00.000Z',
}
export const ossUploadPrepared = {
  replayed: false,
  operation: {
    id: '019a1234-0000-7000-8000-000000000003',
    spaceId: '019a1234-0000-7000-8000-000000000001',
    documentId: '019a1234-0000-7000-8000-000000000002',
    kind: 'upload' as const,
    phase: 'uploading' as const,
    expectedGeneration: '0',
    targetVersionId: null,
    error: null,
  },
  staging: {
    key: `staging/${'a'.repeat(64)}/019a1234-0000-7000-8000-000000000003`,
    maximumBytes: '4',
    expiresAt: '2026-10-20T12:15:00.000Z',
    format: 'txt' as const,
  },
}
