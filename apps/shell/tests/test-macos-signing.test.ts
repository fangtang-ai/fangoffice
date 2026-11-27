import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { requireTestMacSigning, TEST_UPDATE_URL } = require('../build/test-macos-signing.cjs')
const { verifyTestApp, verifyRelease } = require('../../../scripts/verify-test-macos-release.cjs')
const environment = {
  FANGTANG_BUILD_ENV: 'test',
  FANGTANG_UPDATE_URL: TEST_UPDATE_URL,
  CSC_LINK: 'fixture',
  CSC_KEY_PASSWORD: 'fixture',
  CSC_NAME: 'Developer ID Application: Fixture (AAAAAAAAAA)',
  APPLE_ID: 'fixture@example.invalid',
  APPLE_APP_SPECIFIC_PASSWORD: 'fixture',
  APPLE_TEAM_ID: 'AAAAAAAAAA',
}
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('signed macOS test credentials', () => {
  it('passes the identity qualifier expected by the installed electron-builder', () => {
    expect(requireTestMacSigning(environment)).toBe('Fixture (AAAAAAAAAA)')
  })
  it('reports missing variable names without disclosing supplied secret values', () => {
    expect(() =>
      requireTestMacSigning({ ...environment, CSC_LINK: 'do-not-print-this', APPLE_ID: '' }),
    ).toThrow('Missing test macOS signing credentials: APPLE_ID')
  })
  it.each([
    { FANGTANG_BUILD_ENV: 'production' },
    { FANGTANG_UPDATE_URL: TEST_UPDATE_URL.replace('/test', '/stable') },
    { CSC_NAME: '-' },
    { CSC_NAME: 'Developer ID Application: Fixture (BBBBBBBBBB)' },
  ])('rejects mismatched deployment/signing identity %j', (override) => {
    expect(() => requireTestMacSigning({ ...environment, ...override })).toThrow()
  })
})

function fixture({
  signature = 'valid',
  account = 'https://test.fang-tang.cn',
  version = '0.9.16',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'test-mac-signing-'))
  roots.push(root)
  const app = join(root, '方塘Office-Test.app')
  const resources = join(app, 'Contents/Resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'app-update.yml'), `url: ${TEST_UPDATE_URL}\n`)
  writeFileSync(
    join(resources, 'fangtang-defaults.json'),
    JSON.stringify({ account: { accountApiBase: account } }),
  )
  const run = vi.fn((binary: string, args: string[]) => {
    if (binary === 'codesign' && args.includes('--verify') && signature === 'unsigned')
      throw new Error('code has no resources but signature indicates they must be present')
    if (binary === 'codesign' && args.includes('--display'))
      return `Identifier=com.fangtang.app.test\nAuthority=Developer ID Application: Fixture (AAAAAAAAAA)\nTeamIdentifier=AAAAAAAAAA\n`
    if (binary === 'plutil')
      return JSON.stringify({
        CFBundleIdentifier: 'com.fangtang.app.test',
        CFBundleShortVersionString: version,
      })
    return ''
  })
  return { app, resources, run }
}

describe('distributed macOS test app gate', () => {
  const options = { version: '0.9.16', teamId: 'AAAAAAAAAA' }
  it.each(['latest.yml', 'latest-linux.yml', 'FangTangOffice-0.9.16-arm64.dmg', 'malware.exe'])(
    'refuses %s in the Mac test-only publish directory',
    (unexpected) => {
      const root = mkdtempSync(join(tmpdir(), 'test-mac-release-'))
      roots.push(root)
      writeFileSync(join(root, 'fangtang-build-env.txt'), 'test')
      writeFileSync(join(root, 'latest-mac.yml'), 'version: 0.9.16\n')
      writeFileSync(join(root, unexpected), 'fixture')
      const run = vi.fn()
      expect(() => verifyRelease(root, options, run)).toThrow('Unexpected release file')
      expect(run).not.toHaveBeenCalled()
    },
  )
  it('rejects the original unsigned-package failure before claiming updater readiness', () => {
    const { app, run } = fixture({ signature: 'unsigned' })
    expect(() => verifyTestApp(app, options, run)).toThrow('signature')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('requires signature, matching version/team, stapled ticket and Gatekeeper acceptance', () => {
    const { app, run } = fixture()
    verifyTestApp(app, options, run)
    expect(run).toHaveBeenCalledWith('xcrun', ['stapler', 'validate', app])
    expect(run).toHaveBeenCalledWith('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
    expect(() => verifyTestApp(app, { ...options, teamId: 'BBBBBBBBBB' }, run)).toThrow(
      'signing team',
    )
  })
  it.each([{ account: 'https://fang-tang.cn' }, { version: '0.9.14' }])(
    'rejects production endpoints or a stale app %j',
    (override) => {
      const { app, run } = fixture(override)
      expect(() => verifyTestApp(app, options, run)).toThrow()
    },
  )
  it('fails when notarization verification fails', () => {
    const { app, run } = fixture()
    const original = run.getMockImplementation()!
    run.mockImplementation((binary, args) => {
      if (binary === 'xcrun') throw new Error('ticket not found')
      return original(binary, args)
    })
    expect(() => verifyTestApp(app, options, run)).toThrow('ticket not found')
  })
})
