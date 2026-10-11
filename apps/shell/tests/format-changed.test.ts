import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const script = join(__dirname, '../../../tools/format-changed.mjs')

it('runs the formatter JavaScript entry without a shell and preserves filename argument boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'format-changed-'))
  try {
    const git = spawnSync('git', ['init', '--quiet'], { cwd: directory, windowsHide: true })
    expect(git.status).toBe(0)
    const formatterDirectory = join(directory, 'node_modules/prettier/bin')
    await mkdir(formatterDirectory, { recursive: true })
    await writeFile(
      join(formatterDirectory, 'prettier.cjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
    )
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n')
    await writeFile(join(directory, 'document with spaces & symbols.js'), 'const value = 1\n')

    const result = spawnSync(process.execPath, [script, '--check'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, FORMAT_BASE_REF: '' },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      '--check',
      '--ignore-unknown',
      '--',
      '.gitignore',
      'document with spaces & symbols.js',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
