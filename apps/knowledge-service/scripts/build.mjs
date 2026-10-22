import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const directory = fileURLToPath(new URL('../', import.meta.url))
const nodeTarget = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim()
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const runtimePackage = JSON.parse(
  await readFile(new URL('../deployment/package.json', import.meta.url), 'utf8'),
)
const runtimeLock = JSON.parse(
  await readFile(new URL('../deployment/package-lock.json', import.meta.url), 'utf8'),
)
const runtimeFiles = [
  'package.json',
  'package-lock.json',
  'api.env.example',
  'worker.env.example',
  'maintenance.env.example',
  'OPERATIONS.md',
]
const expectedRuntime = {
  name: '@genoffice/knowledge-runtime',
  version: manifest.version,
  private: true,
  type: 'module',
  engines: manifest.engines,
  scripts: {
    'start:api': 'node api.mjs',
    'start:worker': 'node worker.mjs',
    'maintain:queue': 'node maintenance.mjs',
  },
  dependencies: { pg: manifest.dependencies.pg, 'pg-boss': manifest.dependencies['pg-boss'] },
}
// Fail before bundling if release inputs drift from the service's fixed runtime contract.
if (
  !isDeepStrictEqual(runtimePackage, expectedRuntime) ||
  runtimeLock.lockfileVersion !== 3 ||
  runtimeLock.packages?.['']?.version !== manifest.version ||
  !isDeepStrictEqual(runtimeLock.packages?.['']?.engines, manifest.engines) ||
  !isDeepStrictEqual(runtimeLock.packages?.['']?.dependencies, expectedRuntime.dependencies)
)
  throw new Error('Runtime installation inputs do not match the service')
const result = await build({
  absWorkingDir: directory,
  entryPoints: {
    api: 'src/api-main.ts',
    worker: 'src/worker-main.ts',
    maintenance: 'src/maintenance-main.ts',
    'check-config': 'src/check-config.ts',
    parser: 'src/parsing/index.ts',
    'text-worker': 'src/parsing/text-worker.ts',
    'markdown-worker': 'src/parsing/markdown-worker.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: `node${nodeTarget}`,
  format: 'esm',
  external: Object.keys(expectedRuntime.dependencies),
  metafile: true,
  legalComments: 'eof',
})

await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
await Promise.all(
  runtimeFiles.map((file) =>
    copyFile(
      new URL(`../deployment/${file}`, import.meta.url),
      new URL(`../dist/${file}`, import.meta.url),
    ),
  ),
)
await writeFile(
  new URL('../dist/build-meta.json', import.meta.url),
  JSON.stringify(result.metafile, null, 2) + '\n',
)

const sourceInputs = Object.keys(result.metafile.inputs)
if (
  sourceInputs.some(
    (input) =>
      !/^(src\/|\.\.\/\.\.\/packages\/knowledge-contract\/src\/|(?:\.\.\/\.\.\/)?node_modules\/(jose|pdfjs-dist|fast-xml-parser|fast-xml-builder|is-unsafe|path-expression-matcher|strnum|anynum|xml-naming|@nodable\/entities)\/)/.test(
        input,
      ),
  )
) {
  throw new Error('Unexpected knowledge service build input')
}
const source = createHash('sha256')
const sourceFiles = [
  ...sourceInputs,
  '.node-version',
  'package.json',
  'scripts/build.mjs',
  ...runtimeFiles.map((file) => `deployment/${file}`),
].sort()
const sourceContents = await Promise.all(
  sourceFiles.map(async (file) => [file, await readFile(resolve(directory, file))]),
)
for (const [file, content] of sourceContents)
  source.update(file).update('\0').update(content).update('\0')
const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const filenames = [
  'api.mjs',
  'worker.mjs',
  'maintenance.mjs',
  'check-config.mjs',
  'parser.mjs',
  'text-worker.mjs',
  'markdown-worker.mjs',
  ...runtimeFiles,
]
const artifacts = Object.fromEntries(
  await Promise.all(
    filenames.map(async (file) => [file, sha256(await readFile(resolve(directory, 'dist', file)))]),
  ),
)
await writeFile(
  new URL('../dist/build-manifest.json', import.meta.url),
  JSON.stringify(
    {
      schemaVersion: 1,
      nodeTarget,
      serviceVersion: manifest.version,
      lockSha256: sha256(await readFile(new URL('../../../package-lock.json', import.meta.url))),
      sourceSha256: source.digest('hex'),
      externalDependencies: expectedRuntime.dependencies,
      artifacts,
    },
    null,
    2,
  ) + '\n',
)
