import {
  parseKnowledgeDocumentInput,
  parseKnowledgeDocumentTarget,
  parseKnowledgeSpaceInput,
  parseKnowledgeSpaceTarget,
  parseKnowledgeUploadPreparation,
  parseKnowledgeUploadAuthorization,
  parseKnowledgeUploadRequest,
} from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { KnowledgePrincipal } from '../identity'
import type { KnowledgeDatabase } from './database'
import { createKnowledgeDocument, createKnowledgeSpace } from './metadata'
import { uploadInput } from './upload-command'
import { prepareKnowledgeUpload, type KnowledgeUploadPolicy } from './upload-preparation'
import { authorizeKnowledgeOssUpload } from './oss-upload'
import type { KnowledgeOssUploadConfig } from './oss-upload-config'

export function knowledgeUploadRoute(url: string | undefined) {
  const match = url?.match(
    /^\/api\/knowledge\/spaces\/([^/?]+)(?:\/documents\/([^/?]+)(\/uploads(?:\/authorization)?)?)?$/,
  )
  if (!match) return null
  const target = { spaceId: match[1], documentId: match[2] }
  if (match[3]?.endsWith('/authorization'))
    return { kind: 'authorization' as const, method: 'POST', target }
  if (match[3]) return { kind: 'upload' as const, method: 'POST', target }
  if (match[2]) return { kind: 'document' as const, method: 'PUT', target }
  return { kind: 'space' as const, method: 'PUT', target }
}

export async function handleKnowledgeUpload(
  database: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  route: NonNullable<ReturnType<typeof knowledgeUploadRoute>>,
  body: unknown,
  policy: KnowledgeUploadPolicy | undefined,
  now?: () => number,
  authorization?: KnowledgeOssUploadConfig,
) {
  if (route.kind === 'space') {
    const target = uploadInput(parseKnowledgeSpaceTarget, { spaceId: route.target.spaceId })
    const input = uploadInput(parseKnowledgeSpaceInput, body)
    return database.transaction(
      principal,
      async (transaction) => (await createKnowledgeSpace(transaction, target.spaceId, input)).space,
      { now },
    )
  }
  const target = uploadInput(parseKnowledgeDocumentTarget, route.target)
  if (route.kind === 'document') {
    const input = uploadInput(parseKnowledgeDocumentInput, body)
    return database.transaction(
      principal,
      async (transaction) => (await createKnowledgeDocument(transaction, target, input)).document,
      { now },
    )
  }
  const input = uploadInput(parseKnowledgeUploadRequest, body)
  if (!policy) deny('NOT_CONFIGURED')
  if (
    route.kind === 'authorization' &&
    (!authorization || Date.parse(authorization.credentialExpiresAt) - 60000 <= (now ?? Date.now)())
  )
    deny('NOT_CONFIGURED')
  const prepared = await database.transaction(
    principal,
    async (transaction) => {
      return prepareKnowledgeUpload(
        transaction,
        {
          ...input,
          target,
          expectedGeneration: BigInt(input.expectedGeneration),
          declaredBytes: BigInt(input.declaredBytes),
        },
        policy,
      )
    },
    { now },
  )
  const result = parseKnowledgeUploadPreparation(
    {
      operation: prepared.operation,
      preparation: {
        status: 'prepared',
        maximumBytes: prepared.staging.maximumBytes,
        format: prepared.staging.format,
        expiresAt: prepared.staging.expiresAt,
      },
    },
    target,
    input,
  )
  if (route.kind !== 'authorization') return result
  if (!authorization) deny('NOT_CONFIGURED')
  // 对象能力只能在准备事务提交后签发；锁等待后再次校验凭据和原会话期限。
  return parseKnowledgeUploadAuthorization(
    {
      ...result,
      upload: authorizeKnowledgeOssUpload(authorization, prepared, (now ?? Date.now)()),
    },
    target,
    input,
  )
}
