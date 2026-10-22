import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { deny } from '../errors'
import { dedicatedDatabase } from './database-config'
import { setting, type KnowledgeEnvironment } from './config-values'

// 服务根目录（src/runtime/migrate.ts → 上两级），drizzle 生成物相对它定位。
const serviceDirectory = fileURLToPath(new URL('../../', import.meta.url))
// 会话级咨询锁键：同一目标库同时只允许一个迁移入口持有（常量任意但必须固定）。
const MIGRATION_LOCK_KEY = 741188001n
const REVISION_TAG = /^(000\d)_[a-z0-9_]{1,64}$/
const RECEIPT_FILE = 'migration-receipt.json'

export interface KnowledgeMigrateClient {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
}

// io 以逻辑键抽象：journal/sql/snapshot/receipt 相对服务根或回执目录定位，测试可整体替换。
export interface KnowledgeMigrateIo {
  readFile(key: 'journal' | 'snapshot' | 'sql' | 'receipt', name?: string): Promise<string | null>
  writeFile(key: 'receipt', contents: string): Promise<void>
  connect(): Promise<KnowledgeMigrateClient>
}

export interface KnowledgeMigrateConfig {
  readonly role: 'migrator'
  readonly environment: 'production' | 'isolated_test'
  readonly database: ReturnType<typeof dedicatedDatabase>
  readonly receiptDir: string
  readonly expectedRevision: string
  readonly targetRevision: string
  readonly backupCheckpoint: string
}

function revisionTag(value: unknown, kind: 'expected' | 'target') {
  if (typeof value !== 'string') deny('NOT_CONFIGURED')
  if (kind === 'expected' && value === 'EMPTY') return value
  if (!REVISION_TAG.test(value)) deny('NOT_CONFIGURED')
  return value
}

function parseInvocation(argv: string[]) {
  const flags = new Set(['--expected', '--target', '--backup-checkpoint'])
  const found = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flags.has(flag) || found.has(flag) || typeof value !== 'string') deny('NOT_CONFIGURED')
    found.set(flag, value)
  }
  if (found.size !== flags.size) deny('NOT_CONFIGURED')
  const backupCheckpoint = setting(found.get('--backup-checkpoint'), 256)
  // 备份检查点必须是可打印 ASCII 证据标识，至少 8 个字符。
  if (!/^[\x20-\x7e]{8,256}$/.test(backupCheckpoint)) deny('NOT_CONFIGURED')
  return Object.freeze({
    expectedRevision: revisionTag(found.get('--expected'), 'expected'),
    targetRevision: revisionTag(found.get('--target'), 'target'),
    backupCheckpoint,
  })
}

export function parseKnowledgeMigrateConfig(env: KnowledgeEnvironment, argv: string[]) {
  try {
    const environment = env.KNOWLEDGE_ENVIRONMENT ?? 'production'
    if (environment !== 'production' && environment !== 'isolated_test') deny('NOT_CONFIGURED')
    const receiptDir = setting(env.KNOWLEDGE_MIGRATE_RECEIPT_DIR, 2048)
    if (!isAbsolute(receiptDir)) deny('NOT_CONFIGURED')
    return Object.freeze({
      role: 'migrator' as const,
      environment,
      database: dedicatedDatabase(env, 'migrator', environment === 'isolated_test'),
      receiptDir,
      ...parseInvocation(argv),
    })
  } catch {
    // DSN 解析错误可能带凭据，只暴露稳定配置码。
    deny('NOT_CONFIGURED')
  }
}

function sha256(content: string) {
  return createHash('sha256').update(content).digest('hex')
}

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

async function loadJournal(io: KnowledgeMigrateIo) {
  const raw = await io.readFile('journal')
  if (raw === null) throw new Error('Refusing to migrate: generated journal is missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Refusing to migrate: generated journal is not valid JSON')
  }
  const journal = parsed as { version?: unknown; dialect?: unknown; entries?: unknown }
  if (
    journal.version !== '7' ||
    journal.dialect !== 'postgresql' ||
    !Array.isArray(journal.entries) ||
    journal.entries.length === 0
  )
    throw new Error('Refusing to migrate: generated journal shape is unexpected')
  const seen = new Set<string>()
  journal.entries.forEach((entry: JournalEntry, index: number) => {
    if (
      entry?.idx !== index ||
      entry?.version !== '7' ||
      typeof entry?.when !== 'number' ||
      entry?.breakpoints !== true ||
      typeof entry?.tag !== 'string' ||
      !REVISION_TAG.test(entry.tag) ||
      seen.has(entry.tag)
    )
      throw new Error('Refusing to migrate: generated journal entries are inconsistent')
    seen.add(entry.tag)
  })
  return journal.entries as JournalEntry[]
}

interface Artifact {
  name: string
  sql: string
  sha256: string
}

async function loadArtifacts(io: KnowledgeMigrateIo, entries: JournalEntry[]) {
  const artifacts = new Map<string, Artifact>()
  for (const entry of entries) {
    const sql = await io.readFile('sql', entry.tag)
    if (sql === null || sql.length === 0)
      throw new Error(`Refusing to migrate: generated SQL for ${entry.tag} is missing`)
    const snapshot = await io.readFile('snapshot', String(entry.idx))
    if (snapshot === null) throw new Error(`Refusing to migrate: snapshot ${entry.idx} is missing`)
    try {
      JSON.parse(snapshot)
    } catch {
      throw new Error(`Refusing to migrate: snapshot ${entry.idx} is not valid JSON`)
    }
    artifacts.set(entry.tag, { name: `drizzle/${entry.tag}.sql`, sql, sha256: sha256(sql) })
  }
  return artifacts
}

interface MigrationReceipt {
  database: string
  revision: string
  appliedAt: string
  backupCheckpoint: string
  artifacts: { name: string; sha256: string }[]
}

async function loadReceipt(
  io: KnowledgeMigrateIo,
  config: KnowledgeMigrateConfig,
): Promise<MigrationReceipt | null> {
  const raw = await io.readFile('receipt')
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Refusing to migrate: existing migration receipt is not valid JSON')
  }
  const receipt = parsed as MigrationReceipt
  if (
    receipt?.database !== config.database.database ||
    typeof receipt?.revision !== 'string' ||
    !Array.isArray(receipt?.artifacts)
  )
    throw new Error('Refusing to migrate: existing migration receipt does not match the target')
  return receipt
}

function defaultIo(config: KnowledgeMigrateConfig): KnowledgeMigrateIo {
  const receiptPath = join(config.receiptDir, RECEIPT_FILE)
  const read = async (absolute: string) => {
    try {
      return await readFile(absolute, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  }
  return {
    readFile: async (key, name) => {
      if (key === 'journal') return read(resolve(serviceDirectory, 'drizzle/meta/_journal.json'))
      if (key === 'sql') return read(resolve(serviceDirectory, 'drizzle', `${name}.sql`))
      if (key === 'snapshot')
        return read(resolve(serviceDirectory, 'drizzle/meta', `${name}_snapshot.json`))
      return read(receiptPath)
    },
    writeFile: async (_key, contents) => {
      await mkdir(config.receiptDir, { recursive: true })
      await writeFile(receiptPath, contents, 'utf8')
    },
    connect: async () => {
      const pool = new Pool({ ...config.database, max: 1 })
      pool.on('error', () => {})
      const client = await pool.connect()
      return {
        query: (text) => client.query(text),
        end: async () => {
          client.release()
          await pool.end()
        },
      }
    },
  }
}

async function probeSchema(client: KnowledgeMigrateClient) {
  const result = await client.query("SELECT to_regnamespace('knowledge') AS existing")
  return result.rows[0]?.existing !== null && result.rows[0]?.existing !== undefined
}

async function verifyExpectation(
  config: KnowledgeMigrateConfig,
  io: KnowledgeMigrateIo,
  artifacts: Map<string, Artifact>,
  entries: JournalEntry[],
  schemaExists: boolean,
) {
  const receipt = await loadReceipt(io, config)
  if (config.expectedRevision === 'EMPTY') {
    if (schemaExists)
      throw new Error('Refusing to migrate: expected an empty target but the schema already exists')
    if (receipt !== null)
      throw new Error('Refusing to migrate: a receipt exists but the target has no schema')
    return
  }
  if (!schemaExists)
    throw new Error('Refusing to migrate: expected an applied revision but the schema is missing')
  if (receipt === null)
    throw new Error('Refusing to migrate: no receipt evidences the expected revision')
  if (receipt.revision !== config.expectedRevision)
    throw new Error(
      `Refusing to migrate: receipt records ${receipt.revision}, expected ${config.expectedRevision}`,
    )
  const expectedCount = entries.findIndex((entry) => entry.tag === config.expectedRevision) + 1
  if (receipt.artifacts.length !== expectedCount)
    throw new Error('Refusing to migrate: receipt artifact chain does not match the journal')
  for (let index = 0; index < expectedCount; index += 1) {
    const recorded = receipt.artifacts[index]
    const artifact = artifacts.get(entries[index].tag)
    if (recorded?.name !== artifact?.name || recorded?.sha256 !== artifact?.sha256)
      throw new Error(
        `Refusing to migrate: applied artifact ${recorded?.name ?? entries[index].tag} drifted from the receipt`,
      )
  }
}

export async function migrateKnowledgeDatabase(
  config: KnowledgeMigrateConfig,
  io: KnowledgeMigrateIo = defaultIo(config),
): Promise<{ applied: string[]; revision: string }> {
  const entries = await loadJournal(io)
  const artifacts = await loadArtifacts(io, entries)
  const targetIndex = entries.findIndex((entry) => entry.tag === config.targetRevision)
  if (targetIndex < 0)
    throw new Error(`Refusing to migrate: target revision ${config.targetRevision} is unknown`)
  const expectedIndex =
    config.expectedRevision === 'EMPTY'
      ? -1
      : entries.findIndex((entry) => entry.tag === config.expectedRevision)
  if (config.expectedRevision !== 'EMPTY' && expectedIndex < 0)
    throw new Error(
      `Refusing to migrate: expected revision ${config.expectedRevision} is unknown`,
    )
  if (expectedIndex > targetIndex)
    throw new Error('Refusing to migrate: expected revision is newer than the target revision')
  const client = await io.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`)
    const schemaExists = await probeSchema(client)
    await verifyExpectation(config, io, artifacts, entries, schemaExists)
    const pending = entries.slice(expectedIndex + 1, targetIndex + 1)
    for (const entry of pending) {
      const artifact = artifacts.get(entry.tag)
      if (!artifact) {
        throw new Error(`KNOWLEDGE_MIGRATION_SQL_MISSING:${entry.tag}`)
      }
      try {
        await client.query('BEGIN')
        await client.query(artifact.sql)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    }
    if (pending.length === 0) {
      return Object.freeze({ applied: [], revision: config.expectedRevision })
    }
    const chain = entries.slice(0, targetIndex + 1).map((entry) => {
      const artifact = artifacts.get(entry.tag)
      if (!artifact) {
        throw new Error(`KNOWLEDGE_MIGRATION_SQL_MISSING:${entry.tag}`)
      }
      return { name: artifact.name, sha256: artifact.sha256 }
    })
    const receipt: MigrationReceipt = {
      database: config.database.database,
      revision: config.targetRevision,
      appliedAt: new Date().toISOString(),
      backupCheckpoint: config.backupCheckpoint,
      artifacts: chain,
    }
    await io.writeFile(
      'receipt',
      `${JSON.stringify(receipt, null, 2)}\n`,
    )
    return Object.freeze({
      applied: pending.map((entry) => entry.tag),
      revision: config.targetRevision,
    })
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).catch(() => {})
    await client.end()
  }
}