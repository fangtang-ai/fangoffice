import type { FetchImplementation } from 'jose'
import { deny } from '../errors'

const maximumBytes = 256 * 1024

export function boundedJwksFetch(transport: typeof globalThis.fetch): FetchImplementation {
  return async (url, init) => {
    const { signal } = init
    if (signal.aborted) deny('SERVICE_UNAVAILABLE')
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancel = () => {
      const pending = response?.body?.locked ? reader?.cancel() : response?.body?.cancel()
      void pending?.catch(() => undefined)
    }
    let onAbort = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        cancel()
        reject(new Error('JWKS deadline exceeded'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const read = async () => {
      response = await transport(url, { ...init, redirect: 'error', credentials: 'omit' })
      if (signal.aborted) cancel()
      signal.throwIfAborted()
      if (
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== url) ||
        !response.body
      )
        deny('SERVICE_UNAVAILABLE')
      const declared = response.headers.get('Content-Length')
      if (
        declared !== null &&
        (!/^(0|[1-9][0-9]{0,9})$/.test(declared) || Number(declared) > maximumBytes)
      )
        deny('SERVICE_UNAVAILABLE')
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          signal.throwIfAborted()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > maximumBytes) deny('SERVICE_UNAVAILABLE')
          chunks.push(chunk.value)
        }
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return new Response(bytes, { headers: { 'Content-Type': 'application/json' } })
      } finally {
        reader.releaseLock()
      }
    }
    try {
      // Bound the entire fetch/body operation even if a transport adapter ignores AbortSignal.
      return await Promise.race([read(), aborted])
    } catch {
      cancel()
      deny('SERVICE_UNAVAILABLE')
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
