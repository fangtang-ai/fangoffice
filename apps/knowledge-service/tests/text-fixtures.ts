import { createHash } from 'node:crypto'

export const textLimits = { maxBytes: 1024, maxCodePoints: 512, maxLines: 20 }

export function textInput(text: string | Uint8Array) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text
  return { bytes, sourceHash: createHash('sha256').update(bytes).digest('hex') }
}
