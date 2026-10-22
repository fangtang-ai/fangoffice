import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { KnowledgeTextUploadVerification } from '../src/runtime'
import { ossUploadNow, ossUploadPrepared } from './oss-upload-fixtures'

export const verificationPolicy = { maximumFileBytes: 4096n, timeoutMs: 1000 }
export const verificationOptions = { now: () => ossUploadNow }

export function textUploadInput(chunks: Uint8Array[]): KnowledgeTextUploadVerification {
  const bytes = Buffer.concat(chunks)
  return {
    prepared: {
      ...ossUploadPrepared,
      operation: { ...ossUploadPrepared.operation },
      staging: { ...ossUploadPrepared.staging, maximumBytes: bytes.byteLength.toString() },
    },
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    object: {
      key: ossUploadPrepared.staging.key,
      etag: '"synthetic-object-revision"',
      contentType: 'application/octet-stream',
      contentLength: BigInt(bytes.byteLength),
      body: Readable.from(chunks),
    },
  }
}
