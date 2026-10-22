import { deny } from '../errors'
import { setting, type KnowledgeEnvironment } from './config-values'

export function parseUploadHttpCompletionConfig(env: KnowledgeEnvironment, maximumFileBytes?: bigint) {
  const keys = ['KNOWLEDGE_UPLOAD_COMPLETION_QUEUE', 'KNOWLEDGE_UPLOAD_RESERVATION_CHUNKS', 'KNOWLEDGE_UPLOAD_RESERVATION_PHYSICAL_BYTES', 'KNOWLEDGE_UPLOAD_COMPLETION_TIMEOUT_MS'] as const
  if (keys.every((key) => env[key] === undefined)) return undefined
  const queueName = setting(env.KNOWLEDGE_UPLOAD_COMPLETION_QUEUE, 63)
  const positive = (key: typeof keys[number]) => {
    const value = setting(env[key], 19)
    if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) deny('NOT_CONFIGURED')
    return BigInt(value)
  }
  const chunks = positive('KNOWLEDGE_UPLOAD_RESERVATION_CHUNKS')
  const physicalBytes = positive('KNOWLEDGE_UPLOAD_RESERVATION_PHYSICAL_BYTES')
  const timeout = env.KNOWLEDGE_UPLOAD_COMPLETION_TIMEOUT_MS ?? '5000'
  if (!maximumFileBytes || !/^[a-z][a-z0-9_]{0,62}$/.test(queueName) || physicalBytes < maximumFileBytes || !/^[1-9]\d{0,3}$/.test(timeout) || Number(timeout) > 9000) deny('NOT_CONFIGURED')
  return Object.freeze({ queueName, chunks, physicalBytes, timeoutMs: Number(timeout) })
}

export type KnowledgeUploadHttpCompletionConfig = NonNullable<ReturnType<typeof parseUploadHttpCompletionConfig>>
