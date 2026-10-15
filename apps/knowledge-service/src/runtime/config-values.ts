import { deny } from '../errors'

export type KnowledgeEnvironment = Readonly<Record<string, string | undefined>>

export function setting(value: string | undefined, maxLength = 512) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > maxLength ||
    /\p{Cc}/u.test(value)
  )
    deny('NOT_CONFIGURED')
  return value
}

export function port(value: string, allowZero: boolean) {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) deny('NOT_CONFIGURED')
  const number = Number(value)
  if (number < (allowZero ? 0 : 1) || number > 65535) deny('NOT_CONFIGURED')
  return number
}

export function isLoopback(host: string) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
}
