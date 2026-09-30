// Real Electron lifecycle regression. Only synthetic credentials and stubbed fetch.
const { app, ipcMain, safeStorage } = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const [mode, profile, bundle] = process.argv.slice(2)
app.setPath('userData', profile)
app.disableHardwareAcceleration()
process.env.FANGTANG_ACCOUNT_API_BASE = 'https://fixture.invalid'
let endpointCalls = 0
global.fetch = async (url) => {
  if (new URL(url).pathname !== '/api/office/ai-endpoint')
    throw new Error('Unexpected fixture request')
  endpointCalls++
  return new Response(
    JSON.stringify({ data: { provider: 'fangtang', baseUrl: 'https://fixture.invalid/v1' } }),
  )
}
const handlers = new Map()
ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
let auth
let pending
if (mode === 'restore') {
  auth = require(bundle)
  auth.registerAccountIpc()
  pending = auth.waitForAccountManagedDefaults()
}
app
  .whenReady()
  .then(async () => {
    if (mode === 'seed') {
      const session = {
        userId: 'fixture',
        accessToken: 'dummy-token',
        expiresAt: Date.now() + 3600000,
      }
      await writeFile(
        join(profile, 'auth-state.json'),
        JSON.stringify({
          version: 1,
          encrypted: safeStorage.encryptString(JSON.stringify(session)).toString('base64'),
        }),
      )
    } else {
      await pending
      const view = await handlers.get('account:session')()
      for (let i = 0; i < 3; i++) await auth.waitForAccountManagedDefaults()
      await writeFile(
        join(profile, 'result.json'),
        JSON.stringify({
          loggedIn: view.loggedIn,
          provider: auth.getAccountManagedDefaults()?.provider ?? null,
          endpointCalls,
        }),
      )
    }
    app.exit(0)
  })
  .catch(async () => {
    await writeFile(join(profile, 'failure.txt'), 'Local account restore harness failed')
    app.exit(1)
  })
