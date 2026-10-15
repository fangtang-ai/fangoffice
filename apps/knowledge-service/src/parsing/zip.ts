import { inflateRawSync } from 'node:zlib'
import { rejectText } from './errors'

export interface KnowledgeZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  crc: number
  offset: number
}

// Independent CRC-32 (IEEE 802.3) so container integrity can be checked without trusting declared hashes.
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index]!
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function u32(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

// Minimal read-only central-directory reader: stored (0) and deflate (8) entries only; zip64 and encrypted
// archives are rejected because this parser must bound every allocation before it happens.
export function zipEntries(bytes: Uint8Array): KnowledgeZipEntry[] {
  if (bytes.byteLength < 22) rejectText('CORRUPT_CONTAINER')
  let eocd = -1
  const searchStart = Math.max(0, bytes.byteLength - 66)
  for (let index = bytes.byteLength - 22; index >= searchStart; index -= 1) {
    if (u32(bytes, index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) rejectText('CORRUPT_CONTAINER')
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) rejectText('CORRUPT_CONTAINER')
  const count = u16(bytes, eocd + 10)
  const centralSize = u32(bytes, eocd + 12)
  const centralOffset = u32(bytes, eocd + 16)
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) rejectText('CORRUPT_CONTAINER')
  if (centralOffset + centralSize > eocd) rejectText('CORRUPT_CONTAINER')
  const entries: KnowledgeZipEntry[] = []
  let position = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > bytes.byteLength || u32(bytes, position) !== 0x02014b50)
      rejectText('CORRUPT_CONTAINER')
    const flags = u16(bytes, position + 8)
    if (flags & 0x0001) rejectText('CORRUPT_CONTAINER')
    const method = u16(bytes, position + 10)
    if (method !== 0 && method !== 8) rejectText('CORRUPT_CONTAINER')
    const compressedSize = u32(bytes, position + 20)
    const size = u32(bytes, position + 24)
    const nameLength = u16(bytes, position + 28)
    const extraLength = u16(bytes, position + 30)
    const commentLength = u16(bytes, position + 32)
    const offset = u32(bytes, position + 42)
    if (position + 46 + nameLength > bytes.byteLength) rejectText('CORRUPT_CONTAINER')
    const name = Buffer.from(bytes.subarray(position + 46, position + 46 + nameLength)).toString(
      'utf-8',
    )
    entries.push({ name, method, compressedSize, size, crc: u32(bytes, position + 16), offset })
    position += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function readZipEntry(
  bytes: Uint8Array,
  entry: KnowledgeZipEntry,
  maxUncompressed: number,
): Uint8Array {
  if (entry.size > maxUncompressed) rejectText('LIMIT_EXCEEDED')
  if (entry.offset + 30 > bytes.byteLength || u32(bytes, entry.offset) !== 0x04034b50)
    rejectText('CORRUPT_CONTAINER')
  const dataStart =
    entry.offset + 30 + u16(bytes, entry.offset + 26) + u16(bytes, entry.offset + 28)
  if (dataStart + entry.compressedSize > bytes.byteLength) rejectText('CORRUPT_CONTAINER')
  const payload = bytes.subarray(dataStart, dataStart + entry.compressedSize)
  let data: Uint8Array
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) rejectText('CORRUPT_CONTAINER')
    data = payload
  } else {
    let inflated: Uint8Array
    try {
      // Inflate one extra byte so an oversized entry is detected, not silently truncated.
      inflated = inflateRawSync(payload, { maxOutputLength: maxUncompressed + 1 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE')
        rejectText('LIMIT_EXCEEDED')
      rejectText('CORRUPT_CONTAINER')
    }
    if (inflated.byteLength > maxUncompressed) rejectText('LIMIT_EXCEEDED')
    data = inflated
  }
  if (data.byteLength !== entry.size || crc32(data) !== entry.crc) rejectText('CORRUPT_CONTAINER')
  return data
}
