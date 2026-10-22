import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { link, lstat, open, opendir, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { deny, KnowledgePolicyError } from '../errors'
import { deletionIntentIdentity, parseKnowledgeDeletionIntent, type KnowledgeDeletionIntent } from './intent'

const maximumBytes = 8192
const committedName = /^[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/
const pendingName = /^\.pending-[0-9a-f-]{36}$/

function filename(intent: KnowledgeDeletionIntent) {
  return `${createHash('sha256').update(intent.ownerId).digest('hex')}-${intent.id}.json`
}

export async function createFileDeletionJournal(directory: string) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) deny('NOT_CONFIGURED')
  // 服务持有其日志目录：首次启动创建，缺失时不得拒绝就绪。
  await mkdir(directory, { recursive: true }).catch(() => deny('NOT_CONFIGURED'))
  const root = await realpath(directory).catch(() => deny('NOT_CONFIGURED'))
  if (!(await lstat(root)).isDirectory()) deny('NOT_CONFIGURED')

  async function read(name: string) {
    const path = join(root, name)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) deny('SERVICE_UNAVAILABLE')
    const handle = await open(path, 'r')
    try {
      const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(maximumBytes + 1), position: 0 })
      if (bytesRead !== metadata.size || bytesRead > maximumBytes) deny('SERVICE_UNAVAILABLE')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
      const intent = parseKnowledgeDeletionIntent(JSON.parse(text))
      if (filename(intent) !== name) deny('SERVICE_UNAVAILABLE')
      return intent
    } finally { await handle.close() }
  }

  return {
    async append(value: KnowledgeDeletionIntent) {
      const intended = parseKnowledgeDeletionIntent(value)
      const content = JSON.stringify(intended) + '\n'
      if (Buffer.byteLength(content) > maximumBytes) deny('INVALID_REQUEST')
      const temporary = join(root, `.pending-${randomUUID()}`)
      let created = false
      try {
        const handle = await open(temporary, 'wx', 0o600)
        created = true
        try { await handle.writeFile(content, 'utf8'); await handle.sync() }
        finally { await handle.close() }
        // 先完整flush临时对象，再以硬链接原子发布；已提交名字永不覆盖，崩溃残留不冒充确认。
        try { await link(temporary, join(root, filename(intended))) }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
        }
        if (process.platform !== 'win32') {
          const parent = await open(root, 'r')
          try { await parent.sync() } finally { await parent.close() }
        }
        const recorded = await read(filename(intended))
        if (deletionIntentIdentity(recorded) !== deletionIntentIdentity(intended)) deny('VERSION_CONFLICT')
        return recorded
      } catch (error) {
        if (error instanceof KnowledgePolicyError) throw error
        deny('SERVICE_UNAVAILABLE')
      } finally {
        if (created) await unlink(temporary).catch(() => deny('SERVICE_UNAVAILABLE'))
      }
    },
    async *entries() {
      try {
        const files = await opendir(root)
        for await (const entry of files) {
          if (pendingName.test(entry.name) && entry.isFile()) continue
          if (!committedName.test(entry.name) || !entry.isFile()) deny('SERVICE_UNAVAILABLE')
          yield await read(entry.name)
        }
      } catch { deny('SERVICE_UNAVAILABLE') }
    },
  }
}
