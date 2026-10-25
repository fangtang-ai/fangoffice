import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const root = join(__dirname, '../../..')
const script = join(root, 'scripts/check-release-ref.cjs')

function checkRef(channel: string, ref: string, event = 'workflow_dispatch', sha = 'a'.repeat(40)) {
  return run(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      CHANNEL: channel,
      GITHUB_REF: ref,
      GITHUB_EVENT_NAME: event,
      GITHUB_SHA: sha,
    },
  })
}

describe('release source policy', () => {
  it.each(['stable', 'beta'])('allows %s dispatch only from release/fangtang', async (channel) => {
    await expect(checkRef(channel, 'refs/heads/release/fangtang')).resolves.toMatchObject({
      stderr: '',
    })
    for (const ref of ['refs/heads/main', 'refs/heads/feat/env-split', 'refs/tags/v0.9.6']) {
      await expect(checkRef(channel, ref)).rejects.toThrow(/requires release\/fangtang/)
    }
  })

  it('allows test dispatch from a feature branch without promoting it', async () => {
    await expect(checkRef('test', 'refs/heads/feat/env-split')).resolves.toMatchObject({
      stderr: '',
    })
    await expect(checkRef('test', 'refs/tags/v0.9.6')).rejects.toThrow(/test.*branch/i)
  })

  it('allows a matching stable tag only when its commit belongs to release/fangtang', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'apps/shell/package.json'), 'utf8')) as {
      version: string
    }
    const { stdout } = await run('git', ['rev-parse', 'origin/release/fangtang'], { cwd: root })
    await expect(
      checkRef('stable', `refs/tags/v${manifest.version}`, 'push', stdout.trim()),
    ).resolves.toMatchObject({ stderr: '' })
    await expect(
      checkRef('stable', `refs/tags/v${manifest.version}`, 'push', 'f'.repeat(40)),
    ).rejects.toThrow(/must belong to release\/fangtang/)
    await expect(checkRef('stable', 'refs/tags/v999.0.0', 'push')).rejects.toThrow(
      /packaged version/,
    )
    await expect(checkRef('test', `refs/tags/v${manifest.version}`, 'push')).rejects.toThrow(
      /tag pushes.*stable/i,
    )
  })
})
