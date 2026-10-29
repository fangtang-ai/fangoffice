import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { AppInfo } from 'app-builder-lib/out/appInfo'
import type { Packager } from 'app-builder-lib/out/packager'
import { getWindowsInstallationDirName } from 'app-builder-lib/out/targets/targetUtil'
import type { AfterPackContext, Configuration } from 'electron-builder'
import { describe, expect, it, vi } from 'vitest'

const builderPath = join(__dirname, '../electron-builder.cjs')
const builderRequire = createRequire(builderPath)

async function loadBuilder(environment: Record<string, string> = {}, packedLocal = true) {
  const source = await readFile(builderPath, 'utf8')
  const moduleState = { exports: {} }
  const writeFileSync = vi.fn()
  const rmSync = vi.fn()
  const copyFileSync = vi.fn()
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
          return {
            existsSync: (path: string) =>
              path.startsWith('pack-output') && path.endsWith('fangtang-defaults.local.json')
                ? packedLocal
                : true,
            mkdirSync: vi.fn(),
            writeFileSync,
            rmSync,
            copyFileSync,
          }
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
  return {
    config: moduleState.exports as Configuration,
    writeFileSync,
    rmSync,
    notarize,
    copyFileSync,
  }
}

async function afterPack(config: Configuration, targets: string[]) {
  if (typeof config.afterPack !== 'function') throw new Error('AFTER_PACK_HOOK_MISSING')
  return config.afterPack({
    electronPlatformName: 'win32',
    appOutDir: 'pack-output',
    targets: targets.map((name) => ({ name })),
  } as AfterPackContext)
}

it('blocks NSIS output containing local deployment configuration using the actual Target array', async () => {
  const { config, copyFileSync } = await loadBuilder()
  await expect(afterPack(config, ['nsis'])).rejects.toThrow(
    'installer must not ship deployment secrets',
  )
  expect(copyFileSync).not.toHaveBeenCalled()
})

it.each(['nsis', 'portable', 'zip'])(
  'does not copy local configuration into clean %s output',
  async (target) => {
    const { config, copyFileSync } = await loadBuilder({}, false)
    await afterPack(config, [target])
    expect(copyFileSync).not.toHaveBeenCalled()
  },
)

it('blocks a mixed directory and installer target instead of permitting local overrides', async () => {
  const { config, copyFileSync } = await loadBuilder()
  await expect(afterPack(config, ['dir', 'nsis'])).rejects.toThrow('deployment secrets')
  expect(copyFileSync).not.toHaveBeenCalled()
})

it.each([[], ['dir']])(
  'preserves local test overrides only for directory output %j',
  async (...targets) => {
    const { config, copyFileSync } = await loadBuilder({ FANGTANG_BUILD_ENV: 'test' }, false)
    await afterPack(config, targets)
    expect(copyFileSync).toHaveBeenCalledExactlyOnceWith(
      join(__dirname, '../resources/fangtang-defaults.local.json'),
      join('pack-output', 'resources/fangtang-defaults.local.json'),
    )
  },
)

it('never adds developer overrides to a production directory build', async () => {
  const { config, copyFileSync } = await loadBuilder({ FANGTANG_BUILD_ENV: 'production' }, false)
  await afterPack(config, ['dir'])
  expect(copyFileSync).not.toHaveBeenCalled()
})

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
  it('ships an explicit same-origin test knowledge endpoint without developer overrides', async () => {
    const defaults: { account: { accountApiBase: string; knowledgeApiBase?: string } } = JSON.parse(
      await readFile(join(__dirname, '../resources/fangtang-defaults.json'), 'utf8'),
    )
    expect(defaults.account.accountApiBase).toBe('https://test.fang-tang.cn')
    expect(defaults.account.knowledgeApiBase).toBe('https://test.fang-tang.cn/api/knowledge')
    expect(new URL(defaults.account.knowledgeApiBase!).origin).toBe(
      new URL(defaults.account.accountApiBase).origin,
    )
  })

  it('isolates the test install, user profile, desktop entry and updater cache', async () => {
    const { config } = await loadBuilder({ FANGTANG_BUILD_ENV: 'test' })
    expect(config.appId).toBe('com.fangtang.app.test')
    expect(config.productName).toBe('方塘Office-Test')
    expect(config.extraMetadata).toMatchObject({
      productName: '方塘Office-Test',
      name: 'fangtang-office-test',
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

  it.each([
    { environment: 'test', directory: 'fangtang-office-test', productName: '方塘Office-Test' },
    { environment: 'production', directory: 'fangtang-office', productName: '方塘Office' },
  ])(
    'brands the $environment Windows install directory and updater cache',
    async ({ environment, directory, productName }) => {
      const { config } = await loadBuilder({ FANGTANG_BUILD_ENV: environment })
      const manifest: { name: string; version: string } = JSON.parse(
        await readFile(join(__dirname, '../package.json'), 'utf8'),
      )
      const metadata = {
        ...manifest,
        ...(config.extraMetadata as { name?: string; productName?: string }),
      }
      const appInfo = new AppInfo({ metadata, config } as Packager, undefined, config.win)
      expect(getWindowsInstallationDirName(appInfo, true)).toBe(directory)
      expect(appInfo.updaterCacheDirName).toBe(`${directory}-updater`)
      expect(appInfo.productName).toBe(productName)
      expect(appInfo.id).toBe(environment === 'test' ? 'com.fangtang.app.test' : 'com.fangtang.app')
    },
  )
})
