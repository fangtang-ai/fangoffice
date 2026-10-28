const { execFile } = require('node:child_process')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { promisify } = require('node:util')

const run = promisify(execFile)
const root = join(__dirname, '..')

async function main() {
  const channel = process.env.CHANNEL || 'stable'
  const event = process.env.GITHUB_EVENT_NAME
  const ref = process.env.GITHUB_REF || ''
  if (!['stable', 'beta', 'test'].includes(channel)) throw new Error('invalid release channel')

  if (event === 'workflow_dispatch') {
    if (channel === 'test') {
      if (!ref.startsWith('refs/heads/')) throw new Error('test releases require a branch')
    } else if (ref !== 'refs/heads/release/fangtang') {
      throw new Error('production dispatch requires release/fangtang')
    }
  } else if (event === 'push') {
    if (channel !== 'stable') throw new Error('tag pushes publish stable only')
    const { version } = JSON.parse(await readFile(join(root, 'apps/shell/package.json'), 'utf8'))
    if (ref !== `refs/tags/v${version}`) throw new Error('tag must match the packaged version')
    // A valid tag name alone must not authorize a feature-branch production build.
    try {
      const sha = process.env.GITHUB_SHA || ''
      if (!/^[a-f\d]{40}$/.test(sha)) throw new Error('invalid commit SHA')
      await run('git', ['merge-base', '--is-ancestor', sha, 'origin/release/fangtang'], {
        cwd: root,
      })
    } catch {
      throw new Error('production tag commit must belong to release/fangtang')
    }
  } else {
    throw new Error('unsupported release event')
  }
  console.log(`release source verified: ${channel} from ${ref}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
