import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { KnowledgeClient } from '@genoffice/knowledge-client'
import { dialog, type BrowserWindow } from 'electron'
import { KnowledgeDesktopError } from './knowledge-error'

const maximumDocumentBytes = 8 * 1024 * 1024

async function readSelectedDocument(path: string) {
  const format = extname(path).toLowerCase().slice(1)
  if (format !== 'txt' && format !== 'md' && format !== 'docx' && format !== 'pdf')
    throw new KnowledgeDesktopError('UNSUPPORTED_FORMAT')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximumDocumentBytes)
      throw new KnowledgeDesktopError('INVALID_REQUEST')
    if (stat.size === 0) throw new KnowledgeDesktopError('EMPTY_CONTENT')
    // Read one extra byte to detect file growth after selection while keeping reads bounded.
    const buffer = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== stat.size) throw new KnowledgeDesktopError('INVALID_REQUEST')
    const content = buffer.subarray(0, offset)
    // Only inspect bounded binary signatures locally; isolated cloud parsing preserves source locators.
    if (format === 'docx' || format === 'pdf') {
      const valid =
        format === 'pdf'
          ? content.subarray(0, 5).toString('ascii') === '%PDF-'
          : content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))
      if (!valid) throw new KnowledgeDesktopError('UNSUPPORTED_FORMAT')
      return { content, format }
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      throw new KnowledgeDesktopError('UNSUPPORTED_FORMAT')
    }
    if (!text.trim()) throw new KnowledgeDesktopError('EMPTY_CONTENT')
    return { content, format }
  } finally {
    await file.close()
  }
}

export async function uploadKnowledgeText(
  { client, window, check }: { client: KnowledgeClient; window: BrowserWindow; check: () => void },
  spaceId: unknown,
) {
  if (typeof spaceId !== 'string') throw new KnowledgeDesktopError('INVALID_REQUEST')
  await client.listDocuments({ spaceId }, { limit: 1 })
  const picked = await dialog.showOpenDialog(window, {
    title: '上传 TXT / Markdown / DOCX / PDF（最多 8 MiB）',
    properties: ['openFile'],
    filters: [
      { name: 'TXT / Markdown / DOCX / 文字 PDF', extensions: ['txt', 'md', 'docx', 'pdf'] },
    ],
  })
  check()
  if (picked.canceled || picked.filePaths.length === 0) return null
  if (picked.filePaths.length !== 1) throw new KnowledgeDesktopError('INVALID_REQUEST')
  const path = picked.filePaths[0]
  const { content, format } = await readSelectedDocument(path)
  check()
  const sourceHash = createHash('sha256').update(content).digest('hex')
  const target = { spaceId, documentId: randomUUID() }
  const document = await client.createDocument(target, {
    title: basename(path).slice(0, 200),
    tags: [],
    purpose: 'facts',
  })
  const operationId = randomUUID()
  const declaration = {
    operationId,
    idempotencyKey: operationId,
    expectedGeneration: document.generation,
    declaredBytes: String(content.length),
    format,
  }
  await client.uploadFile(target, declaration, new Blob([Uint8Array.from(content)]))
  // Object upload is not ingestion success; complete server verification and queueing before polling.
  const completion = await client.completeUpload(target, { ...declaration, sourceHash })
  return { document, operation: completion.operation }
}
