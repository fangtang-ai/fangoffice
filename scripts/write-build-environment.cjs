const { readFile, rename } = require('node:fs/promises')
const { join, resolve } = require('node:path')

async function main() {
  const directory = resolve(process.env.BUILD_DIR || join(__dirname, '../dist'))
  const pending = join(directory, 'fangtang-build-env.pending.txt')
  const environment = (await readFile(pending, 'utf8')).trim()
  if (!['test', 'production'].includes(environment)) {
    throw new Error('build environment must be "test" or "production"')
  }
  // Run after the builder process exits: update feeds are written after its hooks.
  await rename(pending, join(directory, 'fangtang-build-env.txt'))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
