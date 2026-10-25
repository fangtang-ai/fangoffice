import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// release-critical: stage-release rewrites the electron-updater feeds to the
// ASCII artifact names — a wrong rewrite bricks auto-updates. Run the real
// script (dry run, no OSS) against a scratch artifacts dir.
const SCRIPT = join(__dirname, '../../../scripts/stage-release.cjs')
const run = promisify(execFile)

async function withArtifacts(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'stage-environment-'))
  try {
    const name = 'FangTangOffice-Test-Setup-0.9.2.exe'
    const bytes = Buffer.from('test-installer')
    const digest = createHash('sha512').update(bytes).digest('base64')
    await writeFile(join(directory, name), bytes)
    await writeFile(
      join(directory, 'latest.yml'),
      `version: 0.9.2\npath: ${name}\nsha512: ${digest}\n`,
    )
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function sha(file: string, bytes: string) {
  writeFileSync(file, bytes)
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

describe('stage-release', () => {
  it.skipIf(process.platform !== 'win32').each([undefined, 'test'])(
    'blocks PowerShell publish-only runs with a %j environment marker',
    async (environment) => {
      const root = join(__dirname, '../../..')
      await mkdir(join(root, '.local'), { recursive: true })
      const directory = await mkdtemp(join(root, '.local/publish-environment-'))
      try {
        if (environment !== undefined) {
          await writeFile(join(directory, 'fangtang-build-env.txt'), environment)
        }
        const publisher = join(root, 'scripts/publish-update.ps1').replaceAll("'", "''")
        const buildDirectory = relative(root, directory).replaceAll("'", "''")
        await expect(
          run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `function global:aliyun { throw 'upload must not be reached' }; & '${publisher}' -Channel stable -SkipBuild -BuildDir '${buildDirectory}'`,
            ],
            { windowsHide: true, timeout: 10000 },
          ),
        ).rejects.toThrow(/build environment|built for/)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it('renames Chinese artifacts, rewrites feeds, and verifies sha512 (dry run)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-release-'))
    try {
      writeFileSync(join(dir, 'fangtang-build-env.txt'), 'production')
      const exeSha = sha(join(dir, '方塘Office Setup 0.9.2.exe'), 'exe-bytes')
      const zipSha = sha(join(dir, '方塘Office-0.9.2-arm64-mac.zip'), 'zip-bytes')
      const blockSha = sha(join(dir, '方塘Office Setup 0.9.2.exe.blockmap'), 'blockmap')
      sha(join(dir, '方塘Office-0.9.2-arm64.dmg'), 'dmg') // download-only, feed-unlisted
      writeFileSync(
        join(dir, 'latest.yml'),
        [
          'version: 0.9.2',
          'path: 方塘Office Setup 0.9.2.exe',
          'sha512: ' + exeSha,
          'files:',
          '  - url: 方塘Office Setup 0.9.2.exe',
          '    size: 1',
          '    sha512: ' + exeSha,
          '  - url: 方塘Office Setup 0.9.2.exe.blockmap',
          '    size: 1',
          '    sha512: ' + blockSha,
        ].join('\n'),
      )
      writeFileSync(
        join(dir, 'latest-mac.yml'),
        [
          'version: 0.9.2',
          'path: 方塘Office-0.9.2-arm64-mac.zip',
          'sha512: ' + zipSha,
          'files:',
          '  - url: 方塘Office-0.9.2-arm64-mac.zip',
          '    size: 1',
          '    sha512: ' + zipSha,
        ].join('\n'),
      )

      execFileSync(process.execPath, [SCRIPT, '--artifacts', dir], { stdio: 'pipe' })

      const names = readdirSync(dir).sort()
      expect(names).toContain('FangTangOffice-Setup-0.9.2.exe')
      expect(names).toContain('FangTangOffice-Setup-0.9.2.exe.blockmap')
      expect(names).toContain('FangTangOffice-0.9.2-arm64-mac.zip')
      expect(names).toContain('FangTangOffice-0.9.2-arm64.dmg')
      expect(readFileSync(join(dir, 'latest.yml'), 'utf8')).toContain(
        'path: FangTangOffice-Setup-0.9.2.exe',
      )
      expect(readFileSync(join(dir, 'latest-mac.yml'), 'utf8')).toContain(
        'url: FangTangOffice-0.9.2-arm64-mac.zip',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on a sha512 mismatch before anything is uploaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-release-'))
    try {
      writeFileSync(join(dir, 'fangtang-build-env.txt'), 'production')
      sha(join(dir, '方塘Office Setup 0.9.2.exe'), 'exe-bytes')
      writeFileSync(
        join(dir, 'latest.yml'),
        [
          'version: 0.9.2',
          'path: 方塘Office Setup 0.9.2.exe',
          'sha512: ' + 'bogus'.repeat(22),
          'files:',
          '  - url: 方塘Office Setup 0.9.2.exe',
          '    size: 1',
          '    sha512: ' + 'bogus'.repeat(22),
        ].join('\n'),
      )
      let failed = false
      try {
        execFileSync(process.execPath, [SCRIPT, '--artifacts', dir], { stdio: 'pipe' })
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects artifacts without a build environment before staging', async () => {
    await withArtifacts(async (directory) => {
      await expect(
        run(process.execPath, [SCRIPT, '--artifacts', directory, '--channel', 'stable']),
      ).rejects.toThrow(/build environment marker/)
      expect(await readdir(directory)).toContain('FangTangOffice-Test-Setup-0.9.2.exe')
    })
  })

  it.each(['production', '', 'unknown'])(
    'rejects a %j marker for the test channel',
    async (built) => {
      await withArtifacts(async (directory) => {
        await writeFile(join(directory, 'fangtang-build-env.txt'), built)
        await expect(
          run(process.execPath, [SCRIPT, '--artifacts', directory, '--channel', 'test']),
        ).rejects.toThrow(/built for|build environment/)
      })
    },
  )

  it('preserves the marker across repeated staging and blocks a later production publish', async () => {
    await withArtifacts(async (directory) => {
      await writeFile(join(directory, 'fangtang-build-env.txt'), 'test')
      for (const attempt of [1, 2]) {
        const result = await run(process.execPath, [
          SCRIPT,
          '--artifacts',
          directory,
          '--channel',
          'test',
        ])
        expect(result.stdout, `attempt ${attempt}`).toContain('dry run')
        expect(await readFile(join(directory, 'fangtang-build-env.txt'), 'utf8')).toBe('test')
      }
      await expect(
        run(process.execPath, [SCRIPT, '--artifacts', directory, '--channel', 'stable']),
      ).rejects.toThrow(/built for the "test" line/)
    })
  })

  it('checks the environment without modifying artifacts for the PowerShell publisher', async () => {
    await withArtifacts(async (directory) => {
      await writeFile(join(directory, 'fangtang-build-env.txt'), 'test')
      const before = await readdir(directory)
      const result = await run(process.execPath, [
        SCRIPT,
        '--artifacts',
        directory,
        '--channel',
        'test',
        '--check-env',
      ])
      expect(result.stdout).not.toContain('dry run')
      expect(await readdir(directory)).toEqual(before)
    })
  })

  it('stages the test product name without duplicating its Test suffix', async () => {
    await withArtifacts(async (directory) => {
      await writeFile(join(directory, 'fangtang-build-env.txt'), 'test')
      const exeName = '方塘Office-Test Setup 0.9.2.exe'
      const zipName = '方塘Office-Test-0.9.2-arm64-mac.zip'
      const exeDigest = sha(join(directory, exeName), 'test-exe')
      const zipDigest = sha(join(directory, zipName), 'test-zip')
      await rm(join(directory, 'FangTangOffice-Test-Setup-0.9.2.exe'))
      await writeFile(
        join(directory, 'latest.yml'),
        `version: 0.9.2\npath: ${exeName}\nsha512: ${exeDigest}\n`,
      )
      await writeFile(
        join(directory, 'latest-mac.yml'),
        `version: 0.9.2\npath: ${zipName}\nsha512: ${zipDigest}\n`,
      )
      await run(process.execPath, [SCRIPT, '--artifacts', directory, '--channel', 'test'])
      expect(await readdir(directory)).toEqual(
        expect.arrayContaining([
          'FangTangOffice-Test-Setup-0.9.2.exe',
          'FangTangOffice-Test-0.9.2-arm64-mac.zip',
        ]),
      )
      expect(await readFile(join(directory, 'latest-mac.yml'), 'utf8')).toContain(
        'path: FangTangOffice-Test-0.9.2-arm64-mac.zip',
      )
    })
  })

  it('refuses to publish without OSS access instead of degrading to a GitHub-only release', async () => {
    await withArtifacts(async (directory) => {
      await writeFile(join(directory, 'fangtang-build-env.txt'), 'production')
      // creds stripped so the run can never reach a real upload even on a
      // machine where the aliyun CLI is installed
      const env = { ...process.env }
      delete env.ALIBABA_CLOUD_ACCESS_KEY_ID
      delete env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
      await expect(
        run(
          process.execPath,
          [SCRIPT, '--artifacts', directory, '--channel', 'stable', '--publish'],
          { env },
        ),
      ).rejects.toThrow(/publish to OSS/)
    })
  })
})
