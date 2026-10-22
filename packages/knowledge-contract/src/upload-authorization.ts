import { parseKnowledgeUploadPreparation } from './uploads'
import type { KnowledgeDocumentTarget } from './requests'
import { invalid, literal, object, sha256, text, timestamp } from './validation'

const fields = object({
  key: text(128),
  'Content-Type': literal('application/octet-stream'),
  'x-oss-signature-version': literal('OSS4-HMAC-SHA256'),
  'x-oss-credential': text(256),
  'x-oss-date': text(16),
  'x-oss-security-token': text(8192),
  'x-oss-forbid-overwrite': literal('true'),
  'x-oss-object-acl': literal('private'),
  success_action_status: literal('204'),
  policy: text(16384),
  'x-oss-signature': sha256,
})

export function parseKnowledgeUploadAuthorization(
  input: unknown,
  parent: KnowledgeDocumentTarget,
  requestInput: unknown,
) {
  const source = object({
    operation: (value) => value,
    preparation: (value) => value,
    upload: object({ url: text(256), expiresAt: timestamp, fields }),
  })(input, 'uploadAuthorization')
  const prepared = parseKnowledgeUploadPreparation(
    {
      operation: source.operation,
      preparation: source.preparation,
    },
    parent,
    requestInput,
  )
  const { upload } = source
  const match = upload.url.match(
    /^https:\/\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.oss-([a-z]{2}(?:-[a-z0-9]+){1,4})\.aliyuncs\.com\/$/,
  )
  const dateTime = upload.fields['x-oss-date']
  const credential = upload.fields['x-oss-credential'].split('/')
  if (
    !match ||
    match[2]?.endsWith('-internal') ||
    !/^staging\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(upload.fields.key) ||
    upload.fields.key.split('/').at(-1) !== prepared.operation.id ||
    !/^\d{8}T\d{6}Z$/.test(dateTime) ||
    credential.length !== 5 ||
    credential[1] !== dateTime.slice(0, 8) ||
    credential[2] !== match[2] ||
    credential[3] !== 'oss' ||
    credential[4] !== 'aliyun_v4_request' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(upload.fields.policy) ||
    Date.parse(upload.expiresAt) > Date.parse(prepared.preparation.expiresAt)
  )
    invalid('uploadAuthorization.upload')
  return { ...prepared, upload }
}

export type KnowledgeUploadAuthorization = ReturnType<typeof parseKnowledgeUploadAuthorization>
