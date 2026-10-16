import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { onTestFinished } from 'vitest'

const execute = promisify(execFile)
const prefix = 'fangoffice-knowledge-'

export async function installedRuntimePackage(sourceDirectory: string, files: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  onTestFinished(async () => {
    const [target, parent] = await Promise.all([realpath(directory), realpath(tmpdir())])
    // Resolve the exact freshly created root before recursive removal, including on Windows.
    if (dirname(target) !== parent || !basename(target).startsWith(prefix))
      throw new Error('Refusing to remove an unexpected runtime test directory')
    await rm(target, { recursive: true, force: true })
  })
  const fromRepository = relative(resolve(sourceDirectory, '../..'), directory)
  if (
    !isAbsolute(fromRepository) &&
    fromRepository !== '..' &&
    !fromRepository.startsWith(`..${sep}`)
  )
    throw new Error('Runtime package test must run outside the source repository')
  await Promise.all(
    [...files, 'build-manifest.json', 'build-meta.json'].map((file) =>
      copyFile(join(sourceDirectory, 'dist', file), join(directory, file)),
    ),
  )
  const npmCli =
    process.env.npm_execpath ??
    join(
      dirname(process.execPath),
      ...(process.platform === 'win32' ? [] : ['..', 'lib']),
      'node_modules/npm/bin/npm-cli.js',
    )
  await execute(
    process.execPath,
    [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
    { cwd: directory, timeout: 30000 },
  )
  return directory
}
