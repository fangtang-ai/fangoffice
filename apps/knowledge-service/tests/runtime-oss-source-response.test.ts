import { expect, it, vi } from 'vitest'
import { ossCopyRequest, ossCopyXml, ossSourceFixture, ossSourceKey } from './oss-source-fixtures'

it.each([
  ['content-length', ''],
  ['content-length', '04'],
  ['content-length', '-1'],
  ['content-length', '9223372036854775808'],
  ['content-length', '4, 4'],
  ['content-type', ''],
  ['etag', ''],
  ['etag', 'x'.repeat(257)],
  ['content-encoding', 'gzip'],
  ['content-range', 'bytes 0-3/4'],
  ['x-oss-version-id', 'unexpected-version'],
  ['x-oss-object-type', 'Symlink'],
  ['x-oss-object-type', 'Appendable'],
])('refuses unsafe read metadata %s=%s and cancels the response stream', async (name, value) => {
  const cancelled = vi.fn()
  const headers = new Headers({
    'content-length': '4',
    'content-type': 'text/plain',
    etag: '"rev"',
  })
  headers.set(name!, value!)
  const response = new Response(new ReadableStream({ cancel: cancelled }), { headers })
  const { store } = ossSourceFixture(response)
  await expect(
    store.read({ key: ossSourceKey, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(cancelled).toHaveBeenCalledOnce()
})

it.each([
  [409, 'FileAlreadyExists', 'exists'],
  [412, 'PreconditionFailed', 'source_changed'],
] as const)(
  'recognizes the precise conditional-copy response %i/%s',
  async (status, code, result) => {
    const { store } = ossSourceFixture(
      new Response(`<Error><Code>${code}</Code></Error>`, { status }),
    )
    await expect(store.copy(ossCopyRequest())).resolves.toBe(result)
  },
)

it.each([
  [200, '<Error><Code>InternalError</Code></Error>'],
  [200, ''],
  [200, '<CopyObjectResult/>'],
  [200, '<CopyObjectResult><ETag>"rev"</ETag></CopyObjectResult>'],
  [200, '<!DOCTYPE x [<!ENTITY payload "secret">]><CopyObjectResult/>'],
  [200, 'x'.repeat(16385)],
  [409, '<Error><Code>FileImmutable</Code></Error>'],
  [409, '<Error><Code>AccessDenied</Code></Error>'],
  [412, '<Error><Code>AccessDenied</Code></Error>'],
  [403, '<Error><Code>AccessDenied</Code><Message>synthetic-sts-secret</Message></Error>'],
] as const)(
  'fails closed on an invalid or ambiguous copy response, case %#',
  async (status, xml) => {
    const { store } = ossSourceFixture(new Response(xml, { status }))
    await expect(store.copy(ossCopyRequest())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'SERVICE_UNAVAILABLE',
    })
  },
)

it.each(['x-oss-version-id', 'x-oss-copy-source-version-id'])(
  'refuses versioned copy acknowledgement %s',
  async (header) => {
    const { store } = ossSourceFixture(
      new Response(ossCopyXml, { headers: { [header]: 'unexpected-version' } }),
    )
    await expect(store.copy(ossCopyRequest())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  },
)

it('bounds a stalled copy acknowledgement by the caller signal and cancels its body', async () => {
  const cancelled = vi.fn()
  const { store } = ossSourceFixture(new Response(new ReadableStream({ cancel: cancelled })))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20)
  try {
    await expect(
      store.copy({ ...ossCopyRequest(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(cancelled).toHaveBeenCalledOnce()
  } finally {
    clearTimeout(timer)
  }
})
