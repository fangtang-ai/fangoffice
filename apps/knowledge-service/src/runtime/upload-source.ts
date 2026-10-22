import { deny, KnowledgePolicyError } from '../errors'
import {
  verifyKnowledgeTextObject,
  verifyKnowledgeTextUpload,
  type KnowledgeTextUploadVerification,
  type KnowledgeUploadVerificationPolicy,
} from './upload-verification'

// Trusted adapter: fixed private bucket with versioning disabled; no arbitrary caller bucket/key.
export interface KnowledgeSourceStore {
  copy(request: {
    sourceKey: string
    sourceEtag: string
    key: string
    mimeType: string
    forbidOverwrite: true
    privateAcl: true
    replaceMetadata: true
    signal: AbortSignal
  }): Promise<'copied' | 'exists' | 'source_changed'>
  read(request: {
    key: string
    signal: AbortSignal
  }): Promise<KnowledgeTextUploadVerification['object']>
}

export async function saveKnowledgeTextUpload(
  input: KnowledgeTextUploadVerification,
  store: KnowledgeSourceStore,
  policy: KnowledgeUploadVerificationPolicy,
  { now = Date.now, signal }: { now?: () => number; signal?: AbortSignal } = {},
) {
  const source = {
    ...input,
    prepared: {
      ...input.prepared,
      operation: { ...input.prepared.operation },
      staging: { ...input.prepared.staging },
    },
    object: { ...input.object },
  }
  const limits = { ...policy }
  const expiresAt = Date.parse(source.prepared.staging.expiresAt)
  const deadline = now() + limits.timeoutMs
  let timeout: AbortSignal | undefined
  const checkpoint = () => {
    if (signal?.aborted) deny('CANCELLED')
    const current = now()
    if (!Number.isFinite(current)) deny('SERVICE_UNAVAILABLE')
    if (current >= expiresAt) deny('VERSION_CONFLICT')
    if (current >= deadline || timeout?.aborted) deny('SERVICE_UNAVAILABLE')
    return current
  }
  try {
    const verified = await verifyKnowledgeTextUpload(source, limits, { now, signal })
    const { operation } = source.prepared
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operation.documentId))
      deny('SERVICE_UNAVAILABLE')
    const key = `originals/${verified.key.split('/')[1]}/${operation.documentId}/${operation.id}`
    const current = checkpoint()
    timeout = AbortSignal.timeout(Math.max(1, Math.min(deadline, expiresAt) - current))
    const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
    const result = await sourceIo(
      () =>
        store.copy({
          sourceKey: verified.key,
          sourceEtag: verified.etag,
          key,
          mimeType: verified.mimeType,
          forbidOverwrite: true,
          privateAcl: true,
          replaceMetadata: true,
          signal: lifetime,
        }),
      lifetime,
    )
    checkpoint()
    if (result === 'source_changed') deny('VERSION_CONFLICT')
    if (result !== 'copied' && result !== 'exists') deny('SERVICE_UNAVAILABLE')
    // A copy ACK or matching metadata is not proof: replay also rehashes the real target bytes.
    const object = await sourceIo(
      () => store.read({ key, signal: lifetime }),
      lifetime,
      (late) => late.body.destroy(),
    )
    const stored = await verifyKnowledgeTextObject({ ...source, object }, key, limits, {
      now,
      signal: lifetime,
    })
    checkpoint()
    return { status: 'stored_source' as const, ...stored }
  } catch (error) {
    if (signal?.aborted) deny('CANCELLED')
    if (error instanceof KnowledgePolicyError && error.code === 'NOT_CONFIGURED') throw error
    checkpoint()
    if (error instanceof KnowledgePolicyError) throw error
    deny('SERVICE_UNAVAILABLE')
  } finally {
    source.object.body.destroy()
  }
}

async function sourceIo<Result>(
  work: () => Promise<Result>,
  signal: AbortSignal,
  dispose?: (result: Result) => void,
) {
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new KnowledgePolicyError('SERVICE_UNAVAILABLE'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    // Bound even a non-cooperative adapter; late reads must not leave an open document stream.
    const pending = Promise.resolve()
      .then(() => {
        if (signal.aborted) deny('SERVICE_UNAVAILABLE')
        return work()
      })
      .then((result) => {
        if (signal.aborted) {
          dispose?.(result)
          deny('SERVICE_UNAVAILABLE')
        }
        return result
      })
      .catch(() => deny('SERVICE_UNAVAILABLE'))
    return await Promise.race([pending, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
