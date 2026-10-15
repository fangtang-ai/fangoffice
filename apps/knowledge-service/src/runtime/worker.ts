import type { KnowledgeWorkerConfig } from './config'
import { openKnowledgeDatabase, serviceLifetime, type KnowledgeServiceOptions } from './lifecycle'

export async function startKnowledgeWorker(
  config: KnowledgeWorkerConfig,
  options: KnowledgeServiceOptions = {},
) {
  const database = await openKnowledgeDatabase(config, options)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const lifetime = serviceLifetime(
    database,
    async () => {
      stopped = true
      clearTimeout(timer)
    },
    options,
  )
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      // Keep the standalone process alive and fail closed on database loss; queue consumption belongs to B4.
      void database.verify().then(schedule, lifetime.fail)
    }, 15000)
  }
  schedule()
  return { close: lifetime.close, finished: lifetime.finished }
}
