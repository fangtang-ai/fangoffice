import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function loadPublisher(privateArtifact = false) {
  const root = mkdtempSync(join(tmpdir(), 'signed-test-publisher-'))
  roots.push(root)
  const names = ['FangTangOffice-Test-0.9.16-arm64-mac.zip', 'FangTangOffice-Test-0.9.16-arm64.dmg']
  for (const name of names) writeFileSync(join(root, name), 'synthetic-installer')
  writeFileSync(join(root, 'fangtang-build-env.txt'), 'test')
  writeFileSync(join(root, 'latest-mac.yml'), 'version: 0.9.16\n')
  const uploaded: string[] = []
  const verifyRelease = vi.fn()
  const module = {
    exports: {} as { publish: (directory: string, version: string) => Promise<void> },
  }
  const exec = vi.fn((binary: string, args: string[]) => {
    if (binary !== 'aliyun') return
    expect(args.slice(0, 2)).toEqual(['oss', 'cp'])
    const target = args[3]!
    expect(target.startsWith('oss://fangtang-office-updates/test/')).toBe(true)
    uploaded.push(target.split('/').at(-1)!)
  })
  runInNewContext(
    readFileSync(join(__dirname, '../../../scripts/publish-signed-test-macos.cjs'), 'utf8'),
    {
      module,
      __dirname: join(__dirname, '../../../scripts'),
      process: {
        platform: 'darwin',
        execPath: process.execPath,
        env: {
          APPLE_TEAM_ID: 'AAAAAAAAAA',
          ALIBABA_CLOUD_ACCESS_KEY_ID: 'fixture',
          ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'fixture',
        },
      },
      console,
      URL,
      AbortSignal,
      require: (name: string) => {
        if (name === 'node:child_process') return { execFileSync: exec }
        if (name === './verify-test-macos-release.cjs') return { verifyRelease }
        if (name === './update-feed-utils.cjs')
          return require('../../../scripts/update-feed-utils.cjs')
        return require(name)
      },
      fetch: vi.fn(async (url: string, options?: { method?: string }) => {
        const name = new URL(url).pathname.split('/').at(-1)!
        if (options?.method === 'HEAD') {
          return new Response(null, {
            status: privateArtifact ? 403 : 200,
            headers: { 'content-length': String(statSync(join(root, name)).size) },
          })
        }
        return new Response(
          name === 'latest-mac.yml' && url.includes('/test/') && uploaded.includes(name)
            ? 'version: 0.9.16\n'
            : 'version: 0.9.15\n',
        )
      }),
    },
  )
  return { root, uploaded, publish: module.exports.publish, verifyRelease }
}

it('publishes only signed-test Mac artifacts and exposes the feed last', async () => {
  const { root, uploaded, publish, verifyRelease } = loadPublisher()
  await publish(root, '0.9.16')
  expect(verifyRelease).toHaveBeenCalledOnce()
  expect(uploaded).toHaveLength(3)
  expect(uploaded.at(-1)).toBe('latest-mac.yml')
})

it('does not switch the update feed when an uploaded installer is not public', async () => {
  const { root, uploaded, publish } = loadPublisher(true)
  await expect(publish(root, '0.9.16')).rejects.toThrow('Test artifact is not public')
  expect(uploaded).not.toContain('latest-mac.yml')
})
