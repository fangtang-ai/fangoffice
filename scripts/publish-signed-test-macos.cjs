// Deliberately has no channel argument: this path may only publish macOS test files.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { verifyRelease } = require('./verify-test-macos-release.cjs')
const { semverNewer, ymlVersion } = require('./update-feed-utils.cjs')

const ORIGIN = 'https://fangtang-office-updates.oss-cn-hangzhou.aliyuncs.com'
const PRESERVED = [
  'stable/latest.yml',
  'stable/latest-mac.yml',
  'stable/latest-linux.yml',
  'test/latest.yml',
  'test/latest-linux.yml',
]
async function readPublic(path) {
  const response = await fetch(`${ORIGIN}/${path}`, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(response.status, 200, `Cannot verify preserved feed ${path}`)
  return { status: 200, text: await response.text() }
}
async function publish(directory, version) {
  assert.equal(process.platform, 'darwin', 'Publish only after real macOS signature verification')
  verifyRelease(directory, { version, teamId: process.env.APPLE_TEAM_ID })
  for (const key of ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET']) {
    assert.ok(process.env[key], `Missing ${key}`)
  }
  const before = await Promise.all(PRESERVED.map(readPublic))
  const current = await readPublic('test/latest-mac.yml')
  assert.ok(semverNewer(version, ymlVersion(current.text)), 'Test macOS version must increase')
  execFileSync(
    process.execPath,
    [join(__dirname, 'stage-release.cjs'), '--artifacts', directory, '--channel', 'test'],
    { stdio: 'inherit' },
  )
  const upload = (name) =>
    execFileSync(
      'aliyun',
      [
        'oss',
        'cp',
        join(directory, name),
        `oss://fangtang-office-updates/test/${name}`,
        '--acl',
        'public-read',
        '--force',
        '--region',
        'cn-hangzhou',
      ],
      { stdio: 'inherit' },
    )
  for (const name of readdirSync(directory).filter(
    (name) => !['latest-mac.yml', 'fangtang-build-env.txt'].includes(name),
  )) {
    upload(name)
    const response = await fetch(`${ORIGIN}/test/${encodeURIComponent(name)}`, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    })
    assert.equal(response.status, 200, `Test artifact is not public: ${name}`)
    assert.equal(
      Number(response.headers.get('content-length')),
      statSync(join(directory, name)).size,
    )
  }
  // Never expose an update until every referenced installer is anonymously available.
  upload('latest-mac.yml')
  const published = await readPublic('test/latest-mac.yml')
  assert.equal(published.text, readFileSync(join(directory, 'latest-mac.yml'), 'utf8'))
  const after = await Promise.all(PRESERVED.map(readPublic))
  assert.deepEqual(after, before, 'A feed outside the macOS test release changed')
  console.log(`Published signed macOS test ${version}; stable and other test platforms unchanged`)
}
module.exports = { publish }
if (require.main === module)
  publish(resolve(process.argv[2]), process.argv[3]).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
