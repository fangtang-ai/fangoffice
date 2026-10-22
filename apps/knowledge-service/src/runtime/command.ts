import { KnowledgePolicyError } from '../errors'
import { parseKnowledgeRuntimeConfig } from './config'
import { startKnowledgeApi } from './api'
import { startKnowledgeWorker } from './worker'
import { parseKnowledgeMaintenanceConfig } from './maintenance-config'
import { maintainKnowledgeQueue } from './maintenance'

export async function runKnowledgeCommand(role: 'api' | 'worker' | 'maintenance') {
  const shutdown = new AbortController()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    watchdog ??= setTimeout(() => process.exit(1), 11000).unref()
    shutdown.abort()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    if (role === 'maintenance') {
      await maintainKnowledgeQueue(parseKnowledgeMaintenanceConfig(process.env), {
        signal: shutdown.signal,
      })
      console.info('knowledge-maintenance complete')
      return
    }
    const config = parseKnowledgeRuntimeConfig(process.env, role)
    const options = { signal: shutdown.signal }
    const runtime =
      config.role === 'api'
        ? await startKnowledgeApi(config, options)
        : await startKnowledgeWorker(config, options)
    if (!shutdown.signal.aborted) console.info(`knowledge-${role} ready`)
    const outcome = await runtime.finished
    if (outcome.code !== 'STOPPED') throw new KnowledgePolicyError(outcome.code)
  } catch (error) {
    if (!(
      shutdown.signal.aborted &&
      error instanceof KnowledgePolicyError &&
      error.code === 'CANCELLED'
    )) {
      console.error(error instanceof KnowledgePolicyError ? error.code : 'SERVICE_UNAVAILABLE')
      process.exitCode = 1
      // A driver that fails to drain must not keep a failed service process alive indefinitely.
      setTimeout(() => process.exit(1), 1000).unref()
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    clearTimeout(watchdog)
  }
}
