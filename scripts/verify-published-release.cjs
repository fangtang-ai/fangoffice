// Read-only verification for resuming a release after OSS upload succeeded.
const assert = require('node:assert/strict')
const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const FEEDS = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']
const ORIGIN = 'https://fangtang-office-updates.oss-cn-hangzhou.aliyuncs.com'

async function retry(action) {
  let failure
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await action()
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

async function verifyPublishedRelease(dir, channel = 'stable', request = fetch) {
  assert.ok(['stable', 'beta', 'test'].includes(channel), 'Invalid release channel')
  const base = `${ORIGIN}/${channel}/`
  for (const feed of FEEDS) {
    const expected = readFileSync(join(dir, feed), 'utf8')
    await retry(async () => {
      const response = await request(base + feed, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      })
      assert.equal(response.status, 200, `Published feed unavailable: ${feed}`)
      assert.equal(await response.text(), expected, `Published feed differs: ${feed}`)
    })
  }
  const files = readdirSync(dir).filter(
    (name) => name !== 'fangtang-build-env.txt' && !FEEDS.includes(name),
  )
  for (const file of files) {
    const expected = statSync(join(dir, file)).size
    await retry(async () => {
      const response = await request(base + encodeURIComponent(file), {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      })
      assert.equal(response.status, 200, `Published artifact unavailable: ${file}`)
      assert.equal(
        Number(response.headers.get('content-length')),
        expected,
        `Published artifact size differs: ${file}`,
      )
    })
  }
  console.log(
    `Verified ${FEEDS.length} identical public feeds and ${files.length} artifact sizes; no OSS writes`,
  )
}

module.exports = { verifyPublishedRelease }
if (require.main === module) {
  verifyPublishedRelease(process.argv[2] || 'dist', process.argv[3] || 'stable').catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
