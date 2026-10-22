import { expect, it } from 'vitest'
import { parseKnowledgeRuntimeConfig } from '../src/runtime'
import { environment } from './runtime-fixtures'
import { ossUploadEnvironment } from './oss-upload-fixtures'

const settings = () => ({ ...environment, ...ossUploadEnvironment,
  KNOWLEDGE_UPLOAD_OSS_CREDENTIAL_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
  KNOWLEDGE_UPLOAD_MAXIMUM_FILE_BYTES: '16',
  KNOWLEDGE_UPLOAD_COMPLETION_QUEUE: 'synthetic_upload',
  KNOWLEDGE_UPLOAD_RESERVATION_CHUNKS: '1',
  KNOWLEDGE_UPLOAD_RESERVATION_PHYSICAL_BYTES: '64',
})

it('requires explicit server-side completion ceilings rather than accepting caller projections', () => {
  expect(parseKnowledgeRuntimeConfig(environment, 'api')).not.toHaveProperty('uploadCompletion.queueName')
  expect(parseKnowledgeRuntimeConfig(settings(), 'api')).toHaveProperty('uploadCompletion', {
    queueName: 'synthetic_upload', chunks: 1n, physicalBytes: 64n, timeoutMs: 5000,
  })
})
