import { rejectText } from './errors'

export function xlsxDecimal(raw: string) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[Ee]([+-]?\d+))?$/.exec(raw.trim())
  if (!match || (!match[2] && !match[3]) || raw.length > 512) rejectText('CORRUPT_CONTAINER')
  const exponent = Number(match[4] ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 308) rejectText('CORRUPT_CONTAINER')
  const digits = BigInt((match[2] || '0') + (match[3] ?? ''))
  const scale = (match[3]?.length ?? 0) - exponent
  return {
    coefficient: scale < 0 ? digits * 10n ** BigInt(-scale) : digits,
    scale: Math.max(0, scale),
    negative: match[1] === '-',
  }
}

function fixedDecimal(
  raw: string,
  decimals: number,
  percentage: boolean,
  group: boolean,
  width: number,
) {
  const number = xlsxDecimal(raw)
  const difference = number.scale - decimals - (percentage ? 2 : 0)
  let scaled: bigint
  if (difference <= 0) scaled = number.coefficient * 10n ** BigInt(-difference)
  else {
    const divisor = 10n ** BigInt(difference)
    // Decimal half-away-from-zero rounding never routes a financial-looking value through binary floats.
    scaled =
      number.coefficient / divisor + ((number.coefficient % divisor) * 2n >= divisor ? 1n : 0n)
  }
  const digits = scaled.toString().padStart(decimals + 1, '0')
  const integer = (decimals ? digits.slice(0, -decimals) : digits).padStart(width, '0')
  const fraction = decimals ? `.${digits.slice(-decimals)}` : ''
  return `${number.negative && scaled !== 0n ? '-' : ''}${group ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : integer}${fraction}${percentage ? '%' : ''}`
}

function excelDate(raw: string, system: '1900' | '1904') {
  const number = xlsxDecimal(raw)
  if (number.negative) return null
  const denominator = 10n ** BigInt(number.scale)
  const days = number.coefficient / denominator
  if (days > 2958465n || (system === '1900' && days === 60n)) return null
  const offset = Number(days) - (system === '1900' && days > 60n ? 1 : 0)
  const epoch = system === '1900' ? Date.UTC(1899, 11, 31) : Date.UTC(1904, 0, 1)
  const date = new Date(epoch + offset * 86400000)
  if (date.getUTCFullYear() > 9999) return null
  return {
    date: date.toISOString().slice(0, 10),
    seconds: Number(((number.coefficient % denominator) * 86400n) / denominator),
  }
}

export function formatXlsxNumber(raw: string, format: string, system: '1900' | '1904') {
  xlsxDecimal(raw)
  if (
    ['mm-dd-yy', 'yyyy-mm-dd', 'yyyy/mm/dd', 'm/d/yy h:mm', 'yyyy-mm-dd hh:mm:ss'].includes(format)
  ) {
    const date = excelDate(raw, system)
    const hours = date ? String(Math.floor(date.seconds / 3600)).padStart(2, '0') : ''
    const minutes = date ? String(Math.floor((date.seconds % 3600) / 60)).padStart(2, '0') : ''
    const seconds = date ? String(date.seconds % 60).padStart(2, '0') : ''
    const display = !date
      ? null
      : format.includes('h:mm')
        ? `${date.date} ${hours}:${minutes}${format.includes('ss') ? `:${seconds}` : ''}`
        : format === 'yyyy/mm/dd'
          ? date.date.replaceAll('-', '/')
          : date.date
    return {
      display,
      type: 'date' as const,
      displayKind: 'canonical_date' as const,
      known: display !== null,
    }
  }
  if (format === 'General' || format === '@')
    return { display: raw, type: 'number' as const, displayKind: 'raw' as const, known: true }
  const simple = /^(#,##)?(0{1,20})(?:\.(0{1,10}))?(%)?$/.exec(format)
  if (!simple)
    return {
      display: null,
      type: 'number' as const,
      displayKind: 'unsupported' as const,
      known: true,
    }
  return {
    display: fixedDecimal(raw, simple[3]?.length ?? 0, !!simple[4], !!simple[1], simple[2]!.length),
    type: 'number' as const,
    displayKind: 'formatted' as const,
    known: true,
  }
}
