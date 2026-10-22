import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Configuration } from 'electron-builder'
import { describe, expect, it, vi } from 'vitest'

const builderPath = join(__dirname, '../electron-builder.cjs')
const builderRequire = createRequire(builderPath)

async function loadBuilder(environment: Record<string, string> = {}) {
  const source = await readFile(builderPath, 'utf8')
  const moduleState = { exports: {} }
  const writeFileSync = vi.fn()
  const rmSync = vi.fn()
  const notarize = vi.fn(() => [])
  runInNewContext(
    source,
    {
      __dirname: join(__dirname, '..'),
      module: moduleState,
      process: { platform: 'win32', env: { BUILD_DIR: 'review-output', ...environment } },
      URL,
      console,
      require: (specifier: string) => {
        if (specifier === 'node:fs') {
          return { existsSync: () => true, mkdirSync: vi.fn(), writeFileSync, rmSync }
        }
        if (specifier === 'node:fs/promises') {
          return { mkdir: vi.fn(), writeFile: writeFileSync }
        }
        if (specifier === './build/notarize-dmg.js') return { default: notarize }
        return builderRequire(specifier)
      },
    },
    { filename: builderPath },
  )
  return { config: moduleState.exports as Configuration, writeFileSync, rmSync, notarize }
}

describe('release build provenance', () => {
  it('invalidates the previous marker without certifying before update feeds are written', async () => {
    const { config, writeFileSync, rmSync, notarize } = await loadBuilder()
    expect(rmSync).toHaveBeenCalledWith(join('review-output', 'fangtang-build-env.txt'), {
      force: true,
    })
    expect(writeFileSync).not.toHaveBeenCalled()
    if (typeof config.afterAllArtifactBuild === 'function') {
      await config.afterAllArtifactBuild({
        outDir: 'review-output',
        artifactPaths: ['test.exe'],
        configuration: config,
        platformToTargets: new Map(),
      })
      expect(notarize).toHaveBeenCalledOnce()
    }
    expect(writeFileSync).toHaveBeenCalledWith(
      join('review-output', 'fangtang-build-env.pending.txt'),
      'test',
    )
    expect(writeFileSync).not.toHaveBeenCalledWith(
      join('review-output', 'fangtang-build-env.txt'),
      expect.anything(),
    )
  })
})

describe('deployment-specific update feeds', () => {
  it.each([
    ['test', 'https://updates.example/stable'],
    ['test', 'https://updates.example/beta'],
    ['production', 'https://updates.example/test'],
    ['production', 'https://updates.example/test?cache=1'],
    ['production', 'https://updates.example/test#stable'],
    ['production', 'https://updates.example/%74est'],
    ['production', 'https://updates.example/unknown'],
    ['test', 'http://updates.example/test'],
    ['test', 'https://user:secret@updates.example/test'],
  ])('rejects %s builds using %s', async (buildEnvironment, updateUrl) => {
    await expect(
      loadBuilder({ FANGTANG_BUILD_ENV: buildEnvironment, FANGTANG_UPDATE_URL: updateUrl }),
    ).rejects.toThrow(/FANGTANG_UPDATE_URL/)
  })

  it.each([
    ['test', 'test'],
    ['production', 'stable'],
    ['production', 'beta'],
  ])('normalizes a valid %s build feed for %s', async (buildEnvironment, channel) => {
    const { config } = await loadBuilder({
      FANGTANG_BUILD_ENV: buildEnvironment,
      FANGTANG_UPDATE_URL: ` https://updates.example/${channel}/// `,
    })
    expect(config.publish).toEqual([
      { provider: 'generic', url: `https://updates.example/${channel}`, channel: 'latest' },
    ])
  })

  it('keeps auto-update disabled when no feed is configured', async () => {
    const { config } = await loadBuilder()
    expect(config.publish).toBeUndefined()
  })
})

describe('deployment-specific application identity', () => {
  it('isolates the test install, user profile, desktop entry and updater cache', async () => {
    const { config } = await loadBuilder({ FANGTANG_BUILD_ENV: 'test' })
    expect(config.appId).toBe('com.fangtang.app.test')
    expect(config.productName).toBe('方塘Office-Test')
    expect(config.extraMetadata).toMatchObject({
      productName: '方塘Office-Test',
      name: '@genoffice/shell-test',
      desktopName: 'fangtang-office-test.desktop',
    })
    expect(config.linux?.executableName).toBe('fangtang-office-test')
    expect(config.deb).toMatchObject({
      packageName: 'fangtang-office-test',
      artifactName: 'fangtang-office-test_${version}_${arch}.deb',
    })
    expect(config.rpm).toMatchObject({
      packageName: 'fangtang-office-test',
      artifactName: 'fangtang-office-test-${version}.${arch}.rpm',
    })
  })

  it('preserves the production install and profile identity', async () => {
    const { config } = await loadBuilder({ FANGTANG_BUILD_ENV: 'production' })
    expect(config.appId).toBe('com.fangtang.app')
    expect(config.productName).toBe('方塘Office')
    expect(config.extraMetadata).toMatchObject({ productName: '方塘Office' })
    expect(config.linux?.executableName).toBe('fangtang-office')
    expect(config.deb).toMatchObject({ packageName: 'fangtang-office' })
    expect(config.rpm).toMatchObject({ packageName: 'fangtang-office' })
  })
})
