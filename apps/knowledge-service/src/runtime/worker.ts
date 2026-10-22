import type { KnowledgeWorkerConfig } from './config'
import { createKnowledgeBuildHandler } from './build-handler'
import { openKnowledgeDatabase, serviceLifetime, type KnowledgeServiceOptions } from './lifecycle'
import {
  startKnowledgeQueueConsumer,
  type KnowledgeQueueConsumerOptions,
  type KnowledgeQueueHandler,
} from './queue-consumer'

export interface KnowledgeWorkerOptions extends KnowledgeServiceOptions {
  queue?: Omit<KnowledgeQueueConsumerOptions, 'signal' | 'shutdownTimeoutMs'> & {
    name: string
    handle: KnowledgeQueueHandler
  }
}

export async function startKnowledgeWorker(
  config: KnowledgeWorkerConfig,
  options: KnowledgeWorkerOptions = {},
) {
  const database = await openKnowledgeDatabase(config, options)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let consumer: ReturnType<typeof startKnowledgeQueueConsumer> | undefined
  const lifetime = serviceLifetime(
    database,
    async () => {
      stopped = true
      clearTimeout(timer)
      await consumer?.close()
    },
    options,
  )
  try {
    // 未显式传入队列选项时，按配置装配默认构建管线；两者都缺则 worker 只做巡检。
    const queue =
      options.queue ??
      (config.queueName === undefined
        ? undefined
        : {
            name: config.queueName,
            handle: createKnowledgeBuildHandler(database, config),
          })
    if (queue) {
      consumer = startKnowledgeQueueConsumer(
        database.queue(queue.name),
        queue.handle,
        {
          signal: options.signal,
          pollIntervalMs: options.queue?.pollIntervalMs,
          heartbeatIntervalMs: options.queue?.heartbeatIntervalMs,
          shutdownTimeoutMs: options.shutdownTimeoutMs,
        },
      )
      void consumer.finished.then((outcome) => {
        if (outcome.code !== 'STOPPED') lifetime.fail()
      })
    }
  } catch (error) {
    await lifetime.close()
    throw error
  }
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void database.verify().then(schedule, lifetime.fail)
    }, 15000)
  }
  schedule()
  return { close: lifetime.close, finished: lifetime.finished }
}
