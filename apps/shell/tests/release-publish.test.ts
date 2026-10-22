import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const script = join(__dirname, '../../../scripts/stage-release.cjs')
const preload = join(__dirname, 'fixtures/release-publish-preload.cjs')

interface RemoteFeed {
  status?: number
  body?: string
  error?: string
}

async function withPublisher(
  remote: RemoteFeed,
  action: (publisher: Awaited<ReturnType<typeof createPublisher>>) => Promise<void>,
) {
  const scratch = join(__dirname, '../../../.local')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'release-publish-'))
  try {
    await action(await createPublisher(directory, remote))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function createPublisher(directory: string, remote: RemoteFeed) {
  const installer = 'FangTangOffice-Setup-0.9.2.exe'
  const bytes = Buffer.from('isolated release installer')
  const digest = createHash('sha512').update(bytes).digest('base64')
  const scenario = join(directory, 'scenario.json')
  const uploads = join(directory, 'uploads.jsonl')
  const artifacts = join(directory, 'artifacts')
  await mkdir(artifacts)
  await writeFile(join(artifacts, installer), bytes)
  await writeFile(join(artifacts, 'fangtang-build-env.txt'), 'production')
  await writeFile(
    join(artifacts, 'latest.yml'),
    `version: 0.9.2\npath: ${installer}\nsha512: ${digest}\n`,
  )
  await writeFile(scenario, JSON.stringify({ remote }))
  await writeFile(uploads, '')
  const env = {
    ...process.env,
    RELEASE_TEST_SCENARIO: scenario,
    RELEASE_TEST_UPLOADS: uploads,
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'audit-only',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'audit-only',
  }
  return {
    artifacts,
    env,
    publish: (...flags: string[]) =>
      run(
        process.execPath,
        ['--require', preload, script, '--artifacts', artifacts, '--publish', ...flags],
        { timeout: 10000, env },
      ),
    uploads: async () => (await readFile(uploads, 'utf8')).split('\n').filter(Boolean),
  }
}

describe('release publishing guard', () => {
  it.each<RemoteFeed>([
    { error: 'network unavailable' },
    { status: 403 },
    { status: 404 },
    { status: 429 },
    { status: 503 },
    { body: '<html>not an update manifest</html>' },
    { body: 'version: invalid\n' },
  ])('never uploads when the published version cannot be verified: %j', async (remote) => {
    await withPublisher(remote, async ({ publish, uploads }) => {
      await expect(publish()).rejects.toThrow(/published|remote|HTTP|version|network/i)
      expect(await uploads()).toEqual([])
    })
  })

  it('uploads installers before feeds when the candidate is newer', async () => {
    await withPublisher({ body: 'version: 0.9.1\n' }, async ({ publish, uploads }) => {
      await expect(publish()).resolves.toMatchObject({ stderr: '' })
      const writes = await uploads()
      expect(writes).toHaveLength(2)
      expect(writes[0]).toContain('FangTangOffice-Setup-0.9.2.exe')
      expect(writes[1]).toContain('latest.yml')
      expect(writes.join('\n')).not.toContain('fangtang-build-env.txt')
    })
  })

  it.each(['0.9.2', '0.9.3'])(
    'never overwrites an equal or newer published version %s',
    async (version) => {
      await withPublisher({ body: `version: ${version}\n` }, async ({ publish, uploads }) => {
        await expect(publish()).rejects.toThrow(/not newer than published/)
        expect(await uploads()).toEqual([])
      })
    },
  )

  it('allows confirmed missing feeds only with explicit channel initialization', async () => {
    await withPublisher({ status: 404 }, async ({ publish, uploads }) => {
      await expect(publish('--initial-release')).resolves.toMatchObject({ stderr: '' })
      expect(await uploads()).toHaveLength(2)
    })
  })

  it('refuses initialization when the channel already exists', async () => {
    await withPublisher({ body: 'version: 0.9.1\n' }, async ({ publish, uploads }) => {
      await expect(publish('--initial-release')).rejects.toThrow(/already exists/)
      expect(await uploads()).toEqual([])
    })
  })

  it.each(['--initial-release', '--force'])(
    '%s cannot bypass unreadable remote state',
    async (flag) => {
      await withPublisher({ status: 403 }, async ({ publish, uploads }) => {
        await expect(publish(flag)).rejects.toThrow(/HTTP 403/)
        expect(await uploads()).toEqual([])
      })
    },
  )

  it('rejects mixed platform versions before any upload', async () => {
    await withPublisher({ body: 'version: 0.9.0\n' }, async ({ artifacts, publish, uploads }) => {
      const feed = await readFile(join(artifacts, 'latest.yml'), 'utf8')
      await writeFile(join(artifacts, 'latest-mac.yml'), feed.replace('0.9.2\n', '0.9.1\n'))
      await expect(publish()).rejects.toThrow(/different versions/)
      expect(await uploads()).toEqual([])
    })
  })

  it.skipIf(process.platform !== 'win32')(
    'PowerShell publishing uses the same pre-upload version guard',
    async () => {
      await withPublisher({ body: 'version: 9.0.0\n' }, async ({ artifacts, env, uploads }) => {
        const root = join(__dirname, '../../..')
        const publisher = join(root, 'scripts/publish-update.ps1').replaceAll("'", "''")
        const buildDirectory = relative(root, artifacts).replaceAll("'", "''")
        const manifest = JSON.parse(
          await readFile(join(root, 'apps/shell/package.json'), 'utf8'),
        ) as {
          version: string
        }
        const original = join(artifacts, 'FangTangOffice-Setup-0.9.2.exe')
        const bytes = await readFile(original)
        const installer = `方塘Office Setup ${manifest.version}.exe`
        await writeFile(join(artifacts, installer), bytes)
        await rm(original)
        await writeFile(
          join(artifacts, 'latest.yml'),
          `version: ${manifest.version}\npath: ${installer}\nsha512: ${createHash('sha512').update(bytes).digest('base64')}\n`,
        )
        await expect(
          run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `function global:aliyun { throw 'direct upload bypassed shared publisher' }; & '${publisher}' -Channel stable -SkipBuild -BuildDir '${buildDirectory}'`,
            ],
            {
              env: { ...env, NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` },
              timeout: 10000,
              windowsHide: true,
            },
          ),
        ).rejects.toThrow(/not newer than published/)
        expect(await uploads()).toEqual([])
      })
    },
  )
})
