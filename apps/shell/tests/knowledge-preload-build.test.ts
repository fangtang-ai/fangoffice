import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each([
  ['docs', 'desktop'],
  ['sheets', 'desktopApi'],
  ['slides', 'slidesApi'],
  ['pdf', 'pdfApi'],
  ['markdown', 'markdownApi'],
])(
  '%s installs its built knowledge preload without arbitrary sandbox requires',
  async (editor, apiName) => {
    const { stdout } = await execute(
      process.execPath,
      [join(__dirname, 'fixtures/build-knowledge-preload.mjs'), apiName],
      { cwd: join(__dirname, '../..', editor), timeout: 25000 },
    )
    const result: unknown = JSON.parse(stdout)
    expect(result).toEqual({
      reply: { ok: false, code: 'knowledge:account-required' },
      channels: ['knowledge:chat:session'],
    })
  },
  30_000,
)
