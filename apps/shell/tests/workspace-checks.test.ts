import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface WorkspaceManifest {
  name: string
  scripts: Record<string, string>
}

const root = resolve(__dirname, '../../..')

async function readManifest(directory: string) {
  const contents = await readFile(resolve(directory, 'package.json'), 'utf8')
  return JSON.parse(contents) as WorkspaceManifest
}

describe('CI workspace checks', () => {
  it.each(['test', 'typecheck'])('includes every workspace with a %s script', async (script) => {
    const manifest = await readManifest(root)
    const workspaces = await Promise.all(
      ['apps', 'packages'].map(async (group) => {
        const directory = resolve(root, group)
        const entries = await readdir(directory, { withFileTypes: true })
        return Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => readManifest(resolve(directory, entry.name))),
        )
      }),
    )
    for (const workspace of workspaces.flat()) {
      if (workspace.scripts[script]) {
        expect(manifest.scripts[script], workspace.name).toContain(`-w ${workspace.name}`)
      }
    }
  })
})
