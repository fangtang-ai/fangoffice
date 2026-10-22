import { vi } from 'vitest'
import { createKnowledgeOssSourceStore, parseKnowledgeOssUploadConfig } from '../src/runtime'
import { ossUploadEnvironment, ossUploadNow, ossUploadPrepared } from './oss-upload-fixtures'

export const ossSourceKey = ossUploadPrepared.staging.key
export const ossOriginalKey = `originals/${'a'.repeat(64)}/${ossUploadPrepared.operation.documentId}/${ossUploadPrepared.operation.id}`
export const ossCopyXml =
  '<CopyObjectResult><ETag>"target"</ETag><LastModified>2026-10-20T12:00:00.000Z</LastModified></CopyObjectResult>'

export function ossCopyRequest() {
  return {
    sourceKey: ossSourceKey,
    sourceEtag: '"rev"',
    key: ossOriginalKey,
    mimeType: 'text/plain',
    forbidOverwrite: true,
    privateAcl: true,
    replaceMetadata: true,
    signal: new AbortController().signal,
  } as const
}

export function ossSourceFixture(response = new Response(ossCopyXml)) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
  const config = parseKnowledgeOssUploadConfig(ossUploadEnvironment, ossUploadNow)!
  const store = createKnowledgeOssSourceStore(config, { now: () => ossUploadNow, fetch })
  return { fetch, config, store }
}
