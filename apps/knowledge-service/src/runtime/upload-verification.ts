import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { deny, KnowledgePolicyError } from '../errors'
import type { prepareKnowledgeUpload } from './upload-preparation'

export interface KnowledgeTextUploadVerification {
  prepared: Awaited<ReturnType<typeof prepareKnowledgeUpload>>
  sourceHash: string
  object: {
    key: string
    etag: string
    contentType: string
    contentLength: bigint
    contentEncoding?: string
    body: Readable
  }
}

export interface KnowledgeUploadVerificationPolicy {
  maximumFileBytes: bigint
  timeoutMs: number
}

export async function verifyKnowledgeTextUpload(
  input: KnowledgeTextUploadVerification,
  policy: KnowledgeUploadVerificationPolicy,
  options: { now?: () => number; signal?: AbortSignal } = {},
) {
  const verified = await verifyKnowledgeTextObject(
    input,
    input.prepared.staging.key,
    policy,
    options,
  )
  return { status: 'verified_staging' as const, ...verified }
}

export async function verifyKnowledgeTextObject(
  input: KnowledgeTextUploadVerification,
  expectedKey: string,
  policy: KnowledgeUploadVerificationPolicy,
  { now = Date.now, signal }: { now?: () => number; signal?: AbortSignal } = {},
) {
  const { prepared, sourceHash } = input
  const { operation } = prepared
  // Pin object identity before external I/O; an ETag is opaque, not a content checksum.
  const staging = { ...prepared.staging }
  const object = { ...input.object }
  const expiresAt = Date.parse(staging.expiresAt)
  try {
    if (
      typeof policy.maximumFileBytes !== 'bigint' ||
      policy.maximumFileBytes < 1n ||
      policy.maximumFileBytes > 9223372036854775807n ||
      !Number.isSafeInteger(policy.timeoutMs) ||
      policy.timeoutMs < 1 ||
      policy.timeoutMs > 300_000
    )
      deny('NOT_CONFIGURED')
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) deny('INVALID_REQUEST')
    if (
      !/^staging\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(staging.key) ||
      staging.key.split('/').at(-1) !== operation.id ||
      !/^[1-9]\d{0,18}$/.test(staging.maximumBytes) ||
      BigInt(staging.maximumBytes) > 9223372036854775807n
    )
      deny('SERVICE_UNAVAILABLE')
    if (operation.kind !== 'upload' || operation.phase !== 'uploading') deny('VERSION_CONFLICT')
    const startedAt = now()
    if (!Number.isFinite(expiresAt) || !Number.isFinite(startedAt) || expiresAt <= startedAt)
      deny('VERSION_CONFLICT')
    if (signal?.aborted) deny('CANCELLED')
    const expectedBytes = BigInt(staging.maximumBytes)
    if (expectedBytes > policy.maximumFileBytes) deny('QUOTA_EXCEEDED')
    if (staging.format !== 'txt' && staging.format !== 'md') deny('UNSUPPORTED_FORMAT')
    if (
      object.key !== expectedKey ||
      object.contentLength !== expectedBytes ||
      !/^[\x21-\x7e]{1,256}$/.test(object.etag)
    )
      deny('SERVICE_UNAVAILABLE')
    const mimeType = staging.format === 'txt' ? 'text/plain' : 'text/markdown'
    if (
      (object.contentEncoding !== undefined && object.contentEncoding !== 'identity') ||
      !['application/octet-stream', mimeType, `${mimeType}; charset=utf-8`].includes(
        object.contentType.trim().toLowerCase(),
      )
    )
      deny('UNSUPPORTED_FORMAT')
    const verificationDeadline = startedAt + policy.timeoutMs
    const timeout = AbortSignal.timeout(Math.min(policy.timeoutMs, expiresAt - startedAt))
    const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
    const hash = createHash('sha256')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0n
    let nonempty = false
    let prefix = ''
    const inspect = (text: string) => {
      if (prefix.length < 8) prefix += text.slice(0, 8 - prefix.length)
      if (prefix.startsWith('%PDF-')) deny('UNSUPPORTED_FORMAT')
      for (const point of text) {
        const scalar = point.codePointAt(0)!
        if (
          (scalar < 32 && scalar !== 9 && scalar !== 10 && scalar !== 13) ||
          (scalar >= 127 && scalar <= 159)
        )
          deny('UNSUPPORTED_FORMAT')
      }
      if (!nonempty && /\S/u.test(text)) nonempty = true
    }
    // Decode and hash raw chunks once; never retain the document or silently truncate it.
    await pipeline(
      object.body,
      async (source: AsyncIterable<unknown>) => {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) deny('SERVICE_UNAVAILABLE')
          bytes += BigInt(chunk.byteLength)
          if (bytes > expectedBytes) deny('INVALID_REQUEST')
          hash.update(chunk)
          inspect(decoder.decode(chunk, { stream: true }))
        }
        inspect(decoder.decode())
      },
      { signal: lifetime },
    )
    if (signal?.aborted) deny('CANCELLED')
    const completedAt = now()
    if (!Number.isFinite(completedAt)) deny('SERVICE_UNAVAILABLE')
    if (completedAt >= expiresAt) deny('VERSION_CONFLICT')
    // Timer callbacks may lag synchronous decoding; EOF must still satisfy the original deadline.
    if (completedAt >= verificationDeadline) deny('SERVICE_UNAVAILABLE')
    if (bytes !== expectedBytes) deny('INCOMPLETE_CONTENT')
    if (hash.digest('hex') !== sourceHash) deny('INVALID_REQUEST')
    if (!nonempty) deny('EMPTY_CONTENT')
    return {
      key: object.key,
      etag: object.etag,
      format: staging.format,
      sourceHash,
      sourceBytes: bytes.toString(),
      mimeType,
    }
  } catch (error) {
    if (signal?.aborted) deny('CANCELLED')
    if (error instanceof KnowledgePolicyError) throw error
    if (now() >= expiresAt) deny('VERSION_CONFLICT')
    if (
      error instanceof TypeError &&
      'code' in error &&
      error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
    )
      deny('INVALID_REQUEST')
    deny('SERVICE_UNAVAILABLE')
  } finally {
    object.body.destroy()
  }
}
