export class KnowledgeContractError extends Error {
  readonly code = 'INVALID_REQUEST'

  constructor(readonly path: string) {
    super(`Invalid knowledge contract at ${path}`)
    this.name = 'KnowledgeContractError'
  }
}

export type Decoder<Value> = (input: unknown, path: string) => Value

export function invalid(path: string): never {
  throw new KnowledgeContractError(path)
}

export function record(input: unknown, path: string) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid(path)
  const prototype: unknown = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) invalid(path)
  return input as Record<string, unknown>
}

type Fields = Record<string, Decoder<unknown>>
type Decoded<Shape extends Fields> = { [Key in keyof Shape]: ReturnType<Shape[Key]> }

export function object<const Shape extends Fields>(fields: Shape): Decoder<Decoded<Shape>> {
  return (input, path) => {
    const source = record(input, path)
    if (Reflect.ownKeys(source).some((key) => !Object.hasOwn(fields, key))) invalid(path)
    // Each field is decoded before this single shape-to-object assertion.
    return Object.fromEntries(
      Object.entries(fields).map(([key, decode]) => [key, decode(source[key], `${path}.${key}`)]),
    ) as Decoded<Shape>
  }
}

export function text(maxLength: number): Decoder<string> {
  return (input, path) => {
    if (typeof input !== 'string' || !input.trim() || input.length > maxLength) invalid(path)
    return input
  }
}

export function choice<const Values extends readonly string[]>(
  values: Values,
): Decoder<Values[number]> {
  return (input, path) => {
    if (typeof input !== 'string' || !values.includes(input)) invalid(path)
    return input as Values[number]
  }
}

export const uuid: Decoder<string> = (input, path) => {
  if (
    typeof input !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)
  ) {
    invalid(path)
  }
  return input
}

export function nullable<Value>(decode: Decoder<Value>): Decoder<Value | null> {
  return (input, path) => (input === null ? null : decode(input, path))
}

export function literal<const Value extends string | number | boolean>(
  expected: Value,
): Decoder<Value> {
  return (input, path) => {
    if (input !== expected) invalid(path)
    return expected
  }
}

export function defaulted<Value>(decode: Decoder<Value>, fallback: Value): Decoder<Value> {
  return (input, path) => (input === undefined ? fallback : decode(input, path))
}

export function list<Value>(decode: Decoder<Value>, min: number, max: number): Decoder<Value[]> {
  return (input, path) => {
    if (!Array.isArray(input) || input.length < min || input.length > max) invalid(path)
    return Array.from(input, (value: unknown, index) => decode(value, `${path}[${index}]`))
  }
}

export function unique<Value>(values: Value[], key: (value: Value) => string, path: string) {
  if (new Set(values.map(key)).size !== values.length) invalid(path)
}

export const counter: Decoder<string> = (input, path) => {
  if (
    typeof input !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(input) ||
    (input.length === 19 && input > '9223372036854775807')
  ) {
    invalid(path)
  }
  return input
}

export function integer(min: number, max: number): Decoder<number> {
  return (input, path) => {
    if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
      invalid(path)
    }
    return input
  }
}

export const positiveCounter: Decoder<string> = (input, path) => {
  const result = counter(input, path)
  if (result === '0') invalid(path)
  return result
}

export const sha256: Decoder<string> = (input, path) => {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) invalid(path)
  return input
}

export const timestamp: Decoder<string> = (input, path) => {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
    invalid(path)
  }
  const milliseconds = Date.parse(input)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== input)
    invalid(path)
  return input
}
