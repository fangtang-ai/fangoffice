import { rejectText } from './errors'

export function xlsxString(raw: string) {
  // One pass preserves escaped underscores: _x005F_x0041_ is literal _x0041_, not A.
  const value = raw.replace(/_x([0-9a-f]{4})_/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
  for (const point of value) {
    const code = point.codePointAt(0)!
    if (
      (code < 32 && ![9, 10, 13].includes(code)) ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      rejectText('BINARY_CONTENT')
  }
  return value
}

export function xlsxIsoDate(raw: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
      raw,
    )
  if (!match || !Number.isFinite(Date.parse(raw))) rejectText('CORRUPT_CONTAINER')
  const date = new Date(0)
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  )
    rejectText('CORRUPT_CONTAINER')
  return raw
}
