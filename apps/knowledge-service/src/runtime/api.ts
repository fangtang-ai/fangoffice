import { createServer } from 'node:http'
import { deny, KnowledgePolicyError } from '../errors'
import { createFileDeletionJournal } from '../deletion/file-journal'
import { createKnowledgeAuthenticator, type KnowledgeAuthenticationOptions } from './authentication'
import type { KnowledgeApiConfig } from './config'
import { knowledgeHttpHandler } from './http-handler'
import {
  applyKnowledgeDeletionIntent,
  createKnowledgeReplayPrincipal,
  replayKnowledgeDeletionJournal,
} from './deletion'
import {
  openKnowledgeDatabase,
  serviceLifetime,
  shutdownTimeout,
  withinShutdown,
  type KnowledgeServiceOptions,
} from './lifecycle'

export interface KnowledgeApiOptions extends KnowledgeServiceOptions {
  authentication?: KnowledgeAuthenticationOptions
}

export async function startKnowledgeApi(
  config: KnowledgeApiConfig,
  options: KnowledgeApiOptions = {},
) {
  const authenticate = createKnowledgeAuthenticator(config.auth, options.authentication)
  const database = await openKnowledgeDatabase(config, options)
  // 删除日志目录由服务持有（缺失则创建）；启动监听前先重放，任何未收敛意图都拒绝就绪。
  const journal = await createFileDeletionJournal(config.deletionJournal)
  await replayKnowledgeDeletionJournal(journal, async (intent) => {
    const replayPrincipal = createKnowledgeReplayPrincipal(intent.ownerId, config.auth)
    return database.transaction(replayPrincipal, (transaction) =>
      applyKnowledgeDeletionIntent(transaction, intent),
    )
  })
  const handle = knowledgeHttpHandler(database, authenticate, journal, {
    now: options.authentication?.now,
    uploadPolicy: config.uploadPolicy,
    uploadAuthorization: config.uploadAuthorization,
  })
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000 },
    (request, response) => {
      void handle(request, response)
    },
  )
  server.maxConnections = 128
  server.maxRequestsPerSocket = 50
  server.setTimeout(10000, (socket) => socket.destroy())
  const stop = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => server.closeAllConnections(),
        Math.max(1, shutdownTimeout(options) - 1),
      )
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = () => {
        server.removeListener('listening', onListen)
        reject(new Error('SERVICE_UNAVAILABLE'))
      }
      const onListen = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListen)
      server.listen(config.listen.port, config.listen.host)
    })
    const address = server.address()
    if (options.signal?.aborted) deny('CANCELLED')
    if (!address || typeof address === 'string') deny('SERVICE_UNAVAILABLE')
    const lifetime = serviceLifetime(database, stop, options)
    server.on('error', lifetime.fail)
    return {
      origin: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
      close: lifetime.close,
      finished: lifetime.finished,
    }
  } catch (error) {
    server.close()
    server.closeAllConnections()
    await withinShutdown(() => database.close(), shutdownTimeout(options)).catch(() => undefined)
    if (error instanceof KnowledgePolicyError) throw error
    deny('SERVICE_UNAVAILABLE')
  }
}
