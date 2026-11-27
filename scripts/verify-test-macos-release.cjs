const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { ymlVersion } = require('./update-feed-utils.cjs')
const {
  TEST_UPDATE_URL,
  requireTestMacSigning,
} = require('../apps/shell/build/test-macos-signing.cjs')

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 120000 })
  if (result.error || result.status !== 0)
    throw new Error(
      `${binary} verification failed: ${result.stderr || result.error?.message || result.status}`,
    )
  return result.stdout + result.stderr
}

function verifyTestApp(appPath, { version, teamId }, run = command) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.match(teamId, /^[A-Z0-9]{10}$/)
  run('codesign', ['--verify', '--deep', '--strict', appPath])
  const signature = run('codesign', ['--display', '--verbose=4', appPath])
  assert.ok(signature.includes(`TeamIdentifier=${teamId}\n`), 'Unexpected Apple signing team')
  assert.match(signature, /^Authority=Developer ID Application: /m)
  assert.match(signature, /^Identifier=com\.fangtang\.app\.test$/m)
  const info = JSON.parse(
    run('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents/Info.plist')]),
  )
  assert.equal(info.CFBundleIdentifier, 'com.fangtang.app.test')
  assert.equal(info.CFBundleShortVersionString, version)
  const resources = join(appPath, 'Contents/Resources')
  const feed = readFileSync(join(resources, 'app-update.yml'), 'utf8')
  assert.equal(/^url:\s*(\S+)$/m.exec(feed)?.[1], TEST_UPDATE_URL)
  const defaults = JSON.parse(readFileSync(join(resources, 'fangtang-defaults.json'), 'utf8'))
  assert.equal(defaults.account.accountApiBase, 'https://test.fang-tang.cn')
  assert.ok(
    !readdirSync(resources).includes('fangtang-defaults.local.json'),
    'Local configuration must not ship',
  )
  run('xcrun', ['stapler', 'validate', appPath])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath])
}

function verifyRelease(directory, options, run = command) {
  assert.equal(readFileSync(join(directory, 'fangtang-build-env.txt'), 'utf8').trim(), 'test')
  assert.equal(ymlVersion(readFileSync(join(directory, 'latest-mac.yml'), 'utf8')), options.version)
  const zip = `FangTangOffice-Test-${options.version}-arm64-mac.zip`
  const dmg = `FangTangOffice-Test-${options.version}-arm64.dmg`
  const allowed = new Set([
    zip,
    dmg,
    `${zip}.blockmap`,
    `${dmg}.blockmap`,
    'latest-mac.yml',
    'fangtang-build-env.txt',
  ])
  for (const name of readdirSync(directory))
    assert.ok(allowed.has(name), `Unexpected release file: ${name}`)
  for (const name of [zip, dmg, 'latest-mac.yml'])
    assert.ok(readdirSync(directory).includes(name), `Missing ${name}`)
  const extracted = mkdtempSync(join(tmpdir(), 'fangtang-signed-test-'))
  try {
    run('ditto', ['-x', '-k', join(directory, zip), extracted])
    verifyTestApp(join(extracted, '方塘Office-Test.app'), options, run)
    const disk = join(directory, dmg)
    run('codesign', ['--verify', '--strict', disk])
    const signature = run('codesign', ['--display', '--verbose=4', disk])
    assert.ok(signature.includes(`TeamIdentifier=${options.teamId}\n`), 'DMG signing team differs')
    run('xcrun', ['stapler', 'validate', disk])
  } finally {
    rmSync(extracted, { recursive: true, force: true })
  }
}

module.exports = { verifyTestApp, verifyRelease }
if (require.main === module) {
  try {
    if (process.argv[2] === 'preflight') {
      requireTestMacSigning(process.env)
      console.log('Test-only signing and notarization credentials are configured')
    } else {
      assert.equal(process.platform, 'darwin', 'Signature verification must run on macOS')
      const value = (name) => process.argv[process.argv.indexOf(name) + 1]
      const options = { version: value('--version'), teamId: process.env.APPLE_TEAM_ID }
      if (process.argv.includes('--app')) verifyTestApp(resolve(value('--app')), options)
      else verifyRelease(resolve(value('--artifacts')), options)
      console.log(`Verified signed and notarized test macOS ${options.version}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
