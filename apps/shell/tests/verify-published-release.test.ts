import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { verifyPublishedRelease } = createRequire(import.meta.url)(
  '../../../scripts/verify-published-release.cjs',
) as {
  verifyPublishedRelease(dir: string, channel: string, request: typeof fetch): Promise<void>
}
const feeds = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']
const feedText = 'version: 0.9.12\n'
let dir: string
const request = vi.fn<typeof fetch>()

function publicResponse(input: string | URL | Request) {
  const name = new URL(String(input)).pathname.split('/').at(-1)
  return Promise.resolve(
    feeds.includes(name ?? '')
      ? new Response(feedText)
      : new Response(null, { headers: { 'Content-Length': '10' } }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-published-release-'))
  for (const feed of feeds) writeFileSync(join(dir, feed), feedText)
  writeFileSync(join(dir, 'FangTangOffice-Setup-0.9.12.exe'), '0123456789')
  writeFileSync(join(dir, 'fangtang-build-env.txt'), 'production')
  request.mockReset().mockImplementation(publicResponse)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('published release recovery verification', () => {
  it('verifies exact feeds and installer sizes using only anonymous reads', async () => {
    await verifyPublishedRelease(dir, 'stable', request)
    expect(request).toHaveBeenCalledTimes(4)
    for (const [url, init] of request.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/fangtang-office-updates\.oss-cn-hangzhou\.aliyuncs\.com\/stable\//,
      )
      expect(init?.method ?? 'GET').toMatch(/^(GET|HEAD)$/)
      expect(init?.headers).toBeUndefined()
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('recovers from a transient anonymous network failure', async () => {
    request.mockRejectedValueOnce(new TypeError('fetch failed'))
    await verifyPublishedRelease(dir, 'stable', request)
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('retries failures that occur while reading a response body', async () => {
    request.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('truncated body'))
          },
        }),
      ),
    )
    await verifyPublishedRelease(dir, 'stable', request)
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('rejects another version without overwriting the local or remote feed', async () => {
    request.mockImplementation(async () => new Response('version: 0.9.11\n'))
    await expect(verifyPublishedRelease(dir, 'stable', request)).rejects.toThrow(
      'Published feed differs',
    )
    expect(readFileSync(join(dir, feeds[0]!), 'utf8')).toBe(feedText)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('rejects an artifact whose remote byte count differs', async () => {
    request.mockImplementation(async (url, init) =>
      init?.method === 'HEAD'
        ? new Response(null, { headers: { 'Content-Length': '9' } })
        : publicResponse(url),
    )
    await expect(verifyPublishedRelease(dir, 'stable', request)).rejects.toThrow(
      'artifact size differs',
    )
  })

  it('rejects a missing public artifact', async () => {
    request.mockImplementation(async (url, init) =>
      init?.method === 'HEAD' ? new Response(null, { status: 404 }) : publicResponse(url),
    )
    await expect(verifyPublishedRelease(dir, 'stable', request)).rejects.toThrow(
      'artifact unavailable',
    )
  })

  it('rejects unrecognized channels before any network request', async () => {
    await expect(verifyPublishedRelease(dir, '../other-bucket', request)).rejects.toThrow(
      'Invalid release channel',
    )
    expect(request).not.toHaveBeenCalled()
  })
})
