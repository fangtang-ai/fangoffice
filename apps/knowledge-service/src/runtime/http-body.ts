import type { IncomingMessage } from 'node:http'
import { deny, KnowledgePolicyError } from '../errors'

export async function readKnowledgeJsonBody(request: IncomingMessage, maximumBytes: number) {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const invalid = () => reject(new KnowledgePolicyError('INVALID_REQUEST'))
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maximumBytes) {
        request.pause()
        invalid()
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => resolve(Buffer.concat(chunks)))
    request.once('error', invalid)
    request.once('aborted', invalid)
  })
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    return parsed
  } catch {
    deny('INVALID_REQUEST')
  }
}
