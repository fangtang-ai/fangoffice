import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../../..')

describe('knowledge repository ownership', () => {
  it('keeps the account-bound desktop client as a workspace dependency', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'apps/shell/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    expect(manifest.devDependencies['@genoffice/knowledge-client']).toBe('*')
    expect(manifest.devDependencies['@genoffice/knowledge-service']).toBeUndefined()
  })

  it('does not install the standalone backend in the desktop workspace', async () => {
    await expect(access(join(root, 'apps/knowledge-service/package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, unknown>
    }
    expect(lock.packages['apps/knowledge-service']).toBeUndefined()
    expect(lock.packages['node_modules/@genoffice/knowledge-service']).toBeUndefined()
  })

  it('validates client and contract workspaces without rebuilding the independent service', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const name of ['test:knowledge', 'typecheck:knowledge', 'test', 'typecheck']) {
      expect(manifest.scripts[name]).toContain('@genoffice/knowledge-contract')
      expect(manifest.scripts[name]).toContain('@genoffice/knowledge-client')
      expect(manifest.scripts[name]).not.toContain('@genoffice/knowledge-service')
    }
    expect(manifest.scripts['build:knowledge']).toBeUndefined()
  })

  it('leaves knowledge service candidate builds to the independent repository', async () => {
    await expect(access(join(root, '.github/workflows/knowledge.yml'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
