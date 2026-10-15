import { rejectText } from './errors'

const hardLimits = { maxBytes: 8 * 1024 * 1024, maxCodePoints: 4 * 1024 * 1024, maxLines: 20000 }
const docxHardLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxXmlBytes: 32 * 1024 * 1024,
  maxBlocks: 20000,
}

const pdfHardLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxPages: 2000,
  maxTextItems: 200000,
}

const xlsxHardLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxXmlBytes: 32 * 1024 * 1024,
  maxSheets: 512,
}

const xlsxSelectionHardLimits = {
  maxSelectedSheets: 512,
  maxSelectedCells: 2000000,
}

function boundedLimit(value: unknown, maximum: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    rejectText('INVALID_REQUEST')
  return value
}

function sourceInput(input: unknown) {
  if (
    typeof input !== 'object' ||
    !input ||
    Object.keys(input).some((key) => key !== 'bytes' && key !== 'sourceHash') ||
    !('bytes' in input) ||
    !(input.bytes instanceof Uint8Array) ||
    !(input.bytes.buffer instanceof ArrayBuffer) ||
    !('sourceHash' in input) ||
    typeof input.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.sourceHash)
  )
    rejectText('INVALID_REQUEST')
  return { bytes: input.bytes, sourceHash: input.sourceHash }
}

function exactPolicy<T extends Record<string, number>>(
  policy: unknown,
  keys: readonly (keyof T & string)[],
  maximums: Record<keyof T & string, number>,
) {
  if (
    typeof policy !== 'object' ||
    !policy ||
    Object.keys(policy).length !== keys.length ||
    keys.some((key) => !(key in policy))
  )
    rejectText('INVALID_REQUEST')
  const limits = {} as T
  const writable = limits as unknown as Record<string, number>
  for (const key of keys)
    writable[key] = boundedLimit(policy[key as keyof typeof policy], maximums[key])
  return limits
}

export function textRequest(input: unknown, policy: unknown) {
  const source = sourceInput(input)
  const limits = exactPolicy<{ maxBytes: number; maxCodePoints: number; maxLines: number }>(
    policy,
    ['maxBytes', 'maxCodePoints', 'maxLines'],
    hardLimits,
  )
  if (source.bytes.byteLength > limits.maxBytes) rejectText('LIMIT_EXCEEDED')
  return { input: source, limits }
}

export function pdfRequest(input: unknown, policy: unknown) {
  const source = sourceInput(input)
  const limits = exactPolicy<{ maxBytes: number; maxPages: number; maxTextItems: number }>(
    policy,
    ['maxBytes', 'maxPages', 'maxTextItems'],
    pdfHardLimits,
  )
  if (source.bytes.byteLength > limits.maxBytes) rejectText('LIMIT_EXCEEDED')
  return { input: source, limits }
}

export function docxRequest(input: unknown, policy: unknown) {
  const source = sourceInput(input)
  const limits = exactPolicy<{ maxBytes: number; maxXmlBytes: number; maxBlocks: number }>(
    policy,
    ['maxBytes', 'maxXmlBytes', 'maxBlocks'],
    docxHardLimits,
  )
  if (source.bytes.byteLength > limits.maxBytes) rejectText('LIMIT_EXCEEDED')
  return { input: source, limits }
}

export function xlsxRequest(input: unknown, policy: unknown) {
  const source = sourceInput(input)
  const limits = exactPolicy<{ maxBytes: number; maxXmlBytes: number; maxSheets: number }>(
    policy,
    ['maxBytes', 'maxXmlBytes', 'maxSheets'],
    xlsxHardLimits,
  )
  if (source.bytes.byteLength > limits.maxBytes) rejectText('LIMIT_EXCEEDED')
  return { input: source, limits }
}

export function xlsxSelectionRequest(policy: unknown) {
  const limits = exactPolicy<{ maxSelectedSheets: number; maxSelectedCells: number }>(
    policy,
    ['maxSelectedSheets', 'maxSelectedCells'],
    xlsxSelectionHardLimits,
  )
  return { limits }
}
