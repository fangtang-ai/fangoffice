import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const script = join(__dirname, '../../../tools/check-english-comments.mjs')
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'english-comments-'))
  await run('git', ['init', '--quiet'], { cwd: directory })
  await writeFile(join(directory, 'legacy code.ts'), '// 旧注释\nexport const title = "中文界面"\n')
  await writeFile(join(directory, 'README.md'), '# 旧文档\n')
  await run('git', ['add', '--all'], { cwd: directory })
  await run(
    'git',
    [
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      'commit',
      '--quiet',
      '-m',
      'baseline',
    ],
    { cwd: directory },
  )
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function check(baseRef = 'HEAD') {
  return run(process.execPath, [script], {
    cwd: directory,
    env: { ...process.env, ENGLISH_COMMENT_BASE_REF: baseRef },
    windowsHide: true,
  })
}

describe('English-only comment and documentation gate', () => {
  it('checks added lines without rejecting unchanged legacy content', async () => {
    await writeFile(join(directory, 'README.md'), '# 旧文档\nNew English documentation.\n')
    await expect(check()).resolves.toMatchObject({ stdout: 'check-english-comments: OK\n' })
  })

  it.each([
    {
      file: 'legacy code.ts',
      content: ['// 旧注释', 'export const title = "中文界面"', '// 新注释', ''].join('\n'),
      line: 3,
    },
    { file: 'README.md', content: '# 旧文档\n新增文档\n', line: 2 },
  ])(
    'rejects added Chinese prose in $file with its current line number',
    async ({ file, content, line }) => {
      await writeFile(join(directory, file), content)
      await expect(check()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`${file}:${line}:`),
      })
    },
  )

  it('checks newly tracked Unicode paths with spaces and literal pathspec characters', async () => {
    const file = '新增 文档 [release].md'
    await writeFile(join(directory, file), '# 新增说明\n')
    await run('git', ['add', '--all'], { cwd: directory })
    await expect(check()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${file}:1:`),
    })
  })

  it('allows functional CJK strings while checking multiple changed hunks', async () => {
    await writeFile(
      join(directory, 'legacy code.ts'),
      [
        '// New English comment',
        '// 旧注释',
        'export const title = "中文界面"',
        'export const label = "新标签"',
        '',
      ].join('\n'),
    )
    await expect(check()).resolves.toMatchObject({ stderr: '' })
  })

  it('allows deleting old Chinese prose and files', async () => {
    await writeFile(join(directory, 'legacy code.ts'), 'export const title = "中文界面"\n')
    await rm(join(directory, 'README.md'))
    await expect(check()).resolves.toMatchObject({ stderr: '' })
  })

  it('fails closed when an explicit baseline is not a valid commit', async () => {
    await expect(check('missing-base-ref')).rejects.toMatchObject({
      stderr: expect.stringMatching(/fatal:/),
    })
  })

  it('retains the full-repository audit when no baseline is supplied', async () => {
    await expect(check('')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('legacy code.ts:1:'),
    })
  })
})
