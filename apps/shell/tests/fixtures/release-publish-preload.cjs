const { appendFileSync, readFileSync } = require('node:fs')
const { basename } = require('node:path')
const childProcess = require('node:child_process')

const scenario = JSON.parse(readFileSync(process.env.RELEASE_TEST_SCENARIO, 'utf8'))
const published = new Map()

// Replace only external IO: the CLI still stages and hashes real temporary files.
childProcess.execFileSync = (command, args) => {
  if (command !== 'aliyun') throw new Error(`unexpected external command: ${command}`)
  if (args[0] === 'version') return Buffer.from('audit-only CLI')
  if (args[0] !== 'oss' || args[1] !== 'cp') throw new Error('unexpected OSS operation')
  appendFileSync(process.env.RELEASE_TEST_UPLOADS, `${JSON.stringify(args)}\n`)
  if (args[2].endsWith('.yml')) {
    published.set(basename(args[2]), readFileSync(args[2], 'utf8'))
  }
  return Buffer.alloc(0)
}

global.fetch = async (url, options) => {
  if (!String(url).startsWith('https://fangtang-office-updates.oss-cn-hangzhou.aliyuncs.com/')) {
    throw new Error(`unexpected external URL: ${url}`)
  }
  if (options?.method === 'HEAD') return new Response(null, { status: 200 })
  const name = new URL(url).pathname.split('/').at(-1)
  if (published.has(name)) return new Response(published.get(name))
  const response = scenario.feeds?.[name] ?? scenario.remote
  if (response.error) throw new Error(response.error)
  return new Response(response.body ?? '', { status: response.status ?? 200 })
}
