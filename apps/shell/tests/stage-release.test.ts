import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// release-critical: stage-release rewrites the electron-updater feeds to the
// ASCII artifact names — a wrong rewrite bricks auto-updates. Run the real
// script (dry run, no OSS) against a scratch artifacts dir.
const SCRIPT = join(__dirname, '../../../scripts/stage-release.cjs')

function sha(file: string, bytes: string) {
  writeFileSync(file, bytes)
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

describe('stage-release', () => {
  it('renames Chinese artifacts, rewrites feeds, and verifies sha512 (dry run)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-release-'))
    try {
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
})
