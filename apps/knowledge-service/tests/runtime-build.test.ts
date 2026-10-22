import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { expect, it } from 'vitest'
import { selectedXlsx, workbookParts, xlsxLimits } from './xlsx-fixtures'
import { installedRuntimePackage } from './runtime-package-fixtures'
import { assertRuntimeConfiguration } from './runtime-operations-fixtures'

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
    nodeTarget: '22.13.0',
    serviceVersion: '0.1.0',
    externalDependencies: { pg: '8.23.1', 'pg-boss': '12.37.1' },
  })
  const lock = await readFile(new URL('../../../package-lock.json', import.meta.url))
  expect(manifest.lockSha256).toBe(createHash('sha256').update(lock).digest('hex'))
  expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(Object.keys(manifest.artifacts).sort()).toEqual([
    'OPERATIONS.md',
    'api.env.example',
    'api.mjs',
    'check-config.mjs',
    'maintenance.env.example',
    'maintenance.mjs',
    'markdown-worker.mjs',
    'package-lock.json',
    'package.json',
    'parser.mjs',
    'text-worker.mjs',
    'worker.env.example',
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
  const minimumNode = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim()
  const servicePackage: {
    version: string
    engines: { node: string }
    dependencies: { pg: string; 'pg-boss': string }
  } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const lockedPackages: { packages: Record<string, { engines?: { node: string } }> } = JSON.parse(
    lock.toString('utf8'),
  )
  expect(minimumNode).toBe(manifest.nodeTarget)
  expect(servicePackage.engines.node).toBe(`>=${minimumNode}`)
  expect(lockedPackages.packages['apps/knowledge-service']?.engines).toEqual(servicePackage.engines)
  expect(workflow).toContain('node-version-file: apps/knowledge-service/.node-version')
  expect(workflow).not.toMatch(/^\s+node-version:/m)
  expect(workflow).toContain('knowledge-${{ steps.node.outputs.node-version }}-${{ matrix.os }}')
  const runtimePackage: Record<string, unknown> = JSON.parse(
    await readFile(new URL('../dist/package.json', import.meta.url), 'utf8'),
  )
  expect(runtimePackage).toEqual({
    name: '@genoffice/knowledge-runtime',
    version: servicePackage.version,
    private: true,
    type: 'module',
    engines: servicePackage.engines,
    scripts: {
      'start:api': 'node api.mjs',
      'start:worker': 'node worker.mjs',
      'maintain:queue': 'node maintenance.mjs',
    },
    dependencies: {
      pg: servicePackage.dependencies.pg,
      'pg-boss': servicePackage.dependencies['pg-boss'],
    },
  })
  const runtimeLock: {
    lockfileVersion: number
    packages: Record<string, { dev?: boolean; link?: boolean }>
  } = JSON.parse(await readFile(new URL('../dist/package-lock.json', import.meta.url), 'utf8'))
  expect(runtimeLock.lockfileVersion).toBe(3)
  expect(runtimeLock.packages['']).toMatchObject({
    version: servicePackage.version,
    engines: servicePackage.engines,
    dependencies: {
      pg: servicePackage.dependencies.pg,
      'pg-boss': servicePackage.dependencies['pg-boss'],
    },
  })
  for (const [path, entry] of Object.entries(runtimeLock.packages)) {
    if (!path) continue
    expect(path).toMatch(/^node_modules\//)
    expect(entry.dev).not.toBe(true)
    expect(entry.link).not.toBe(true)
  }
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
  expect(metadata.outputs['dist/check-config.mjs']?.imports).toEqual([])
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
      .every((entry) => ['pg', 'pg-boss'].includes(entry.path) || entry.path.startsWith('node:')),
  ).toBe(true)
  const runtimeDirectory = await installedRuntimePackage(directory, Object.keys(manifest.artifacts))
  const installed = await readdir(join(runtimeDirectory, 'node_modules'))
  expect(installed).toContain('pg')
  expect(installed).toContain('pg-boss')
  for (const unwanted of ['pdfjs-dist', 'pdf-lib', 'electron', 'typescript', 'vitest'])
    expect(installed).not.toContain(unwanted)
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    DATABASE_URL: 'postgresql://business.invalid/business',
    PGHOST: 'business.invalid',
    NODE_ENV: 'test',
  }
  await assertRuntimeConfiguration(runtimeDirectory, env)
  const parserSmoke = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { createHash } = await import('node:crypto');
    const { parseKnowledgeTextInWorker, parseKnowledgeMarkdownInWorker } = await import('./parser.mjs');
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
    { cwd: runtimeDirectory, env, timeout: 5000 },
  )
  expect(JSON.parse(parserSmoke.stdout)).toEqual({
    text: 'abc',
    status: 'complete',
    kinds: ['heading', 'paragraph'],
    preview: '# 标题\n\n正文\n',
  })
  const xlsx = selectedXlsx(
    workbookParts(
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>00123</t></is></c></row></sheetData>',
    ),
  )
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage().drawText('Runtime PDF smoke', { font })
  const pdfBytes = await pdf.save()
  const binarySmoke = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const { parseKnowledgeXlsxDocument, parseKnowledgePdfDocument } = await import('./parser.mjs');
    const fixture = JSON.parse(process.argv[1]);
    fixture.input.bytes = Uint8Array.from(Buffer.from(fixture.input.bytes, 'base64'));
    const document = parseKnowledgeXlsxDocument(fixture.input, fixture.policy);
    fixture.pdf.bytes = Uint8Array.from(Buffer.from(fixture.pdf.bytes, 'base64'));
    const pdfDocument = await parseKnowledgePdfDocument(fixture.pdf, { maxBytes: 65536, maxPages: 1, maxTextItems: 10 });
    console.log(JSON.stringify({ value: document.units[0].cells[0].value, a1: document.units[0].locator.a1, status: document.coverage.status, pdfText: pdfDocument.text, pdfStatus: pdfDocument.coverage.status }));
  `,
      JSON.stringify({
        input: { ...xlsx, bytes: Buffer.from(xlsx.bytes).toString('base64') },
        policy: xlsxLimits,
        pdf: {
          bytes: Buffer.from(pdfBytes).toString('base64'),
          sourceHash: createHash('sha256').update(pdfBytes).digest('hex'),
        },
      }),
    ],
    { cwd: runtimeDirectory, env, timeout: 5000 },
  )
  expect(JSON.parse(binarySmoke.stdout)).toEqual({
    value: '00123',
    a1: 'A1',
    status: 'complete',
    pdfText: 'Runtime PDF smoke',
    pdfStatus: 'complete',
  })
  for (const role of ['api', 'worker', 'maintenance']) {
    const result = await execute(process.execPath, [`${role}.mjs`], {
      cwd: runtimeDirectory,
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
}, 60000)
