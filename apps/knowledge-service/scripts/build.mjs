import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../', import.meta.url))
const nodeTarget = '22.12.0'
const result = await build({
  absWorkingDir: directory,
  entryPoints: {
    api: 'src/api-main.ts',
    worker: 'src/worker-main.ts',
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
  external: ['pg'],
  metafile: true,
  legalComments: 'eof',
})

await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
await writeFile(
  new URL('../dist/build-meta.json', import.meta.url),
  JSON.stringify(result.metafile, null, 2) + '\n',
)

const sourceInputs = Object.keys(result.metafile.inputs)
if (
  sourceInputs.some(
    (input) =>
      !/^(src\/|\.\.\/\.\.\/packages\/knowledge-contract\/src\/|(?:\.\.\/\.\.\/)?node_modules\/(jose|pdfjs-dist)\/)/.test(
        input,
      ),
  )
) {
  throw new Error('Unexpected knowledge service build input')
}
const source = createHash('sha256')
const sourceFiles = [...sourceInputs, 'package.json', 'scripts/build.mjs'].sort()
const sourceContents = await Promise.all(
  sourceFiles.map(async (file) => [file, await readFile(resolve(directory, file))]),
)
for (const [file, content] of sourceContents)
  source.update(file).update('\0').update(content).update('\0')
const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const filenames = ['api.mjs', 'worker.mjs', 'parser.mjs', 'text-worker.mjs', 'markdown-worker.mjs']
const artifacts = Object.fromEntries(
  await Promise.all(
    filenames.map(async (file) => [file, sha256(await readFile(resolve(directory, 'dist', file)))]),
  ),
)
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await writeFile(
  new URL('../dist/build-manifest.json', import.meta.url),
  JSON.stringify(
    {
      schemaVersion: 1,
      nodeTarget,
      serviceVersion: manifest.version,
      lockSha256: sha256(await readFile(new URL('../../../package-lock.json', import.meta.url))),
      sourceSha256: source.digest('hex'),
      externalDependencies: { pg: manifest.dependencies.pg },
      artifacts,
    },
    null,
    2,
  ) + '\n',
)
