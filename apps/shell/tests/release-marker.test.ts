import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const script = join(__dirname, '../../../scripts/write-build-environment.cjs')

it('certifies the selected environment only after the packaging command succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-marker-'))
  try {
    for (const environment of ['test', 'production']) {
      await writeFile(join(directory, 'fangtang-build-env.pending.txt'), environment)
      await run(process.execPath, [script], {
        env: {
          ...process.env,
          BUILD_DIR: directory,
          FANGTANG_BUILD_ENV: environment === 'test' ? 'production' : 'test',
        },
      })
      expect(await readFile(join(directory, 'fangtang-build-env.txt'), 'utf8')).toBe(environment)
      await expect(
        readFile(join(directory, 'fangtang-build-env.pending.txt'), 'utf8'),
      ).rejects.toThrow(/ENOENT/)
    }
    const manifest = JSON.parse(await readFile(join(__dirname, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const platform of ['win', 'mac', 'linux']) {
      expect(manifest.scripts[`dist:${platform}`]).toContain(
        `electron-builder --${platform} && node ../../scripts/write-build-environment.cjs`,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
