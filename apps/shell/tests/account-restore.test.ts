import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const testDir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// This regression uses the Windows OS keyring and an actual Electron process.
// Linux unit-test runners have neither a display server nor an OS keyring.
it.skipIf(process.platform !== 'win32')(
  'restores an encrypted account after Electron ready and provisions AI once',
  async () => {
    const profile = await mkdtemp(join(tmpdir(), 'fangtang-account-restore-'))
    if (
      dirname(profile) !== resolve(tmpdir()) ||
      !basename(profile).startsWith('fangtang-account-restore-')
    ) {
      throw new Error('Refusing to use an unexpected fixture directory')
    }
    try {
      const bundle = join(profile, 'auth.cjs')
      await build({
        stdin: {
          contents:
            "export { registerAccountIpc } from './apps/shell/src/main/auth'; export { getAccountManagedDefaults, waitForAccountManagedDefaults } from '@genoffice/electron-utils';",
          resolveDir: resolve(testDir, '../../..'),
          loader: 'ts',
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        outfile: bundle,
      })
      const electronPath: string = require('electron')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const fixture = join(testDir, 'fixtures/account-restore.cjs')
      for (const mode of ['seed', 'restore']) {
        await run(electronPath, [fixture, mode, profile, bundle], {
          env,
          windowsHide: true,
          timeout: 15000,
        })
      }
      const result: unknown = JSON.parse(await readFile(join(profile, 'result.json'), 'utf8'))
      expect(result).toEqual({ loggedIn: true, provider: 'fangtang', endpointCalls: 1 })
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  },
  40000,
)
