import { Readable } from 'node:stream'
import { vi } from 'vitest'
import type { KnowledgeSourceStore } from '../src/runtime'
import { textUploadInput } from './upload-verification-fixtures'

export function sourceStoreFixture() {
  const input = textUploadInput([Buffer.from('test')])
  const key = `originals/${'a'.repeat(64)}/${input.prepared.operation.documentId}/${input.prepared.operation.id}`
  const target = {
    ...input.object,
    key,
    etag: '"target-revision"',
    body: Readable.from([Buffer.from('test')]),
  }
  const copy = vi.fn<KnowledgeSourceStore['copy']>(async () => 'copied')
  const read = vi.fn<KnowledgeSourceStore['read']>(async () => target)
  return { input, key, target, copy, read }
}
