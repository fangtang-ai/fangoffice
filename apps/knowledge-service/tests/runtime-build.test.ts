import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const directory = fileURLToPath(new URL('../', import.meta.url))

it('builds independent Node entries and rejects missing configuration without business fallbacks', async () => {
  await execute(process.execPath, ['scripts/build.mjs'], { cwd: directory, timeout: 15000 })
  const manifest: {
    schemaVersion: number
    nodeTarget: string
    serviceVersion: string
    lockSha256: string
    sourceSha256: string
    externalDependencies: Record<string, string>
    artifacts: Record<string, string>
  } = JSON.parse(await readFile(new URL('../dist/build-manifest.json', import.meta.url), 'utf8'))
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    nodeTarget: '22.12.0',
    serviceVersion: '0.1.0',
    externalDependencies: { pg: '8.23.1' },
  })
  const lock = await readFile(new URL('../../../package-lock.json', import.meta.url))
  expect(manifest.lockSha256).toBe(createHash('sha256').update(lock).digest('hex'))
  expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(Object.keys(manifest.artifacts).sort()).toEqual([
    'api.mjs',
    'markdown-worker.mjs',
    'parser.mjs',
    'text-worker.mjs',
    'worker.mjs',
  ])
  for (const [file, hash] of Object.entries(manifest.artifacts)) {
    const artifact = await readFile(new URL(`../dist/${file}`, import.meta.url))
    expect(hash).toBe(createHash('sha256').update(artifact).digest('hex'))
  }
  const workflow = await readFile(
    new URL('../../../.github/workflows/knowledge.yml', import.meta.url),
    'utf8',
  )
  for (const file of Object.keys(manifest.artifacts))
    expect(workflow).toContain(`apps/knowledge-service/dist/${file}`)
  const metadata: {
    inputs: Record<string, unknown>
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>
  } = JSON.parse(await readFile(new URL('../dist/build-meta.json', import.meta.url), 'utf8'))
  expect(Object.keys(metadata.inputs).some((input) => input.includes('src/api-main.ts'))).toBe(true)
  expect(Object.keys(metadata.inputs).some((input) => input.includes('src/worker-main.ts'))).toBe(
    true,
  )
  expect(
    Object.keys(metadata.inputs).some((input) => input.includes('src/parsing/text-worker.ts')),
  ).toBe(true)
  expect(
    Object.keys(metadata.inputs).some((input) => input.includes('src/parsing/markdown-worker.ts')),
  ).toBe(true)
  expect(Object.keys(metadata.outputs)).toContain('dist/parser.mjs')
  expect(Object.keys(metadata.outputs)).toContain('dist/text-worker.mjs')
  expect(Object.keys(metadata.outputs)).toContain('dist/markdown-worker.mjs')
  expect(
    Object.keys(metadata.inputs).filter((input) =>
      /(?:^|\/)apps\/shell\/|(?:^|\/)electron(?:\/|$)|(?:^|\/)fangtang-site\/|(?:^|\/)tests\//.test(
        input,
      ),
    ),
  ).toEqual([])
  expect(
    Object.values(metadata.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.external)
      .every((entry) => entry.path === 'pg' || entry.path.startsWith('node:')),
  ).toBe(true)
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    DATABASE_URL: 'postgresql://business.invalid/business',
    PGHOST: 'business.invalid',
    NODE_ENV: 'test',
  }
  const parserSmoke = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { createHash } = await import('node:crypto');
    const { parseKnowledgeTextInWorker, parseKnowledgeMarkdownInWorker } = await import('./dist/parser.mjs');
    const textBytes = Uint8Array.from([97,98,99]);
    const textHash = createHash('sha256').update(textBytes).digest('hex');
    const result = await parseKnowledgeTextInWorker({ bytes: textBytes, sourceHash: textHash }, { maxBytes: 3, maxCodePoints: 3, maxLines: 1 });
    const mdSource = '# 标题\\n\\n正文\\n';
    const mdBytes = Uint8Array.from(Buffer.from(mdSource, 'utf8'));
    const mdHash = createHash('sha256').update(mdBytes).digest('hex');
    const markdown = await parseKnowledgeMarkdownInWorker({ bytes: mdBytes, sourceHash: mdHash }, { maxBytes: 1024, maxCodePoints: 512, maxLines: 20 });
    console.log(JSON.stringify({ text: result.text, status: result.coverage.status, kinds: markdown.units.map((u) => u.kind), preview: markdown.preview }));
  `,
    ],
    { cwd: directory, env, timeout: 5000 },
  )
  expect(JSON.parse(parserSmoke.stdout)).toEqual({
    text: 'abc',
    status: 'complete',
    kinds: ['heading', 'paragraph'],
    preview: '# 标题\n\n正文\n',
  })
  for (const role of ['api', 'worker']) {
    const result = await execute(process.execPath, [`dist/${role}.mjs`], {
      cwd: directory,
      env,
      timeout: 5000,
    }).then(
      () => {
        throw new Error('unconfigured service must fail')
      },
      (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error) || !('stderr' in error)) throw error
        return error
      },
    )
    expect(result.code).toBe(1)
    expect(String(result.stderr).trim()).toBe('NOT_CONFIGURED')
  }
}, 25000)
