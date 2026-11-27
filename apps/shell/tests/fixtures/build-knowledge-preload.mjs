import { runInNewContext } from 'node:vm'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'

// The bundler reads dependencies from cwd; a fresh process matches each editor's real workspace build.
const resolved = await resolveConfig(
  { logLevel: 'silent', build: { write: false } },
  'build',
  'production',
)
if (!resolved.config?.preload) throw new Error('Missing editor preload configuration')
const result = await build(resolved.config.preload)
const outputs = Array.isArray(result) ? result : [result]
const entry = outputs
  .flatMap((output) => ('output' in output ? output.output : []))
  .find((output) => output.type === 'chunk' && output.isEntry)
if (!entry || entry.type !== 'chunk') throw new Error('Missing built editor preload')
const exposed = new Map()
const channels = []
runInNewContext(entry.code, {
  require: (specifier) => {
    if (specifier !== 'electron') throw new Error(`Unavailable sandbox module: ${specifier}`)
    return {
      contextBridge: {
        exposeInMainWorld: (name, api) => exposed.set(name, api),
      },
      ipcRenderer: {
        invoke: async (channel) => {
          channels.push(channel)
          return { ok: false, code: 'knowledge:account-required' }
        },
        on: () => {},
        send: () => {},
        removeListener: () => {},
      },
      webUtils: { getPathForFile: () => '' },
    }
  },
  window: { addEventListener: () => {} },
  process: { contextIsolated: true, env: {} },
  console,
})
const api = exposed.get(process.argv[2])?.knowledge
if (!api) throw new Error('Missing knowledge bridge in built editor preload')
const reply = await api.session()
console.log(JSON.stringify({ reply, channels }))
