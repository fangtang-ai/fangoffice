import { rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, expect, it } from 'vitest'
import * as runtime from '../src/runtime'
import { localDirectory, localSettings, openLocalDatabase } from './local-database'

const target = {
  name: 'knowledge_migrate_entry',
  receiptDir: join(localDirectory, 'migrate-entry-receipt'),
}

async function dropTarget(bootstrap: Pool) {
  await bootstrap.query(`DROP DATABASE IF EXISTS ${target.name}`)
}

const bootstrap = (await openLocalDatabase('bootstrap')).pool
afterAll(async () => {
  await dropTarget(bootstrap)
  await bootstrap.end()
})

it('applies the full generated journal to a fresh database and verifies an idempotent rerun', async () => {
  await dropTarget(bootstrap)
  await bootstrap.query(
    `CREATE DATABASE ${target.name} OWNER knowledge_migrator ALLOW_CONNECTIONS true`,
  )
  const settings = await localSettings()
  const password = settings.roles.migrator.password
  await rm(target.receiptDir, { recursive: true, force: true })
  await mkdir(target.receiptDir, { recursive: true })
  const env = {
    KNOWLEDGE_ENVIRONMENT: 'isolated_test',
    KNOWLEDGE_DATABASE_NAME: target.name,
    KNOWLEDGE_MIGRATOR_DATABASE_ROLE: 'knowledge_migrator',
    KNOWLEDGE_MIGRATOR_DATABASE_URL: `postgresql://knowledge_migrator:${password}@127.0.0.1:55432/${target.name}`,
    KNOWLEDGE_MIGRATE_RECEIPT_DIR: target.receiptDir,
  }
  const argv = [
    '--expected',
    'EMPTY',
    '--target',
    '0006_upload_completion',
    '--backup-checkpoint',
    'local-entry-checkpoint-20261022',
  ]
  const config = runtime.parseKnowledgeMigrateConfig(env, argv)
  const outcome = await runtime.migrateKnowledgeDatabase(config)
  expect(outcome.applied).toHaveLength(7)
  expect(outcome.revision).toBe('0006_upload_completion')

  const verifier = new Pool({
    host: '127.0.0.1',
    port: 55432,
    database: target.name,
    user: 'knowledge_migrator',
    password,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000,
  })
  try {
    const schema = await verifier.query(
      "SELECT to_regnamespace('knowledge') AS existing, count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'knowledge'",
    )
    expect(schema.rows[0]?.existing).not.toBeNull()
    expect(schema.rows[0]?.tables).toBeGreaterThan(15)
  } finally {
    await verifier.end()
  }

  const receiptPath = join(target.receiptDir, 'migration-receipt.json')
  const receiptBefore = await readFile(receiptPath, 'utf8')

  const rerun = await runtime.migrateKnowledgeDatabase(
    runtime.parseKnowledgeMigrateConfig(env, [
      '--expected',
      '0006_upload_completion',
      '--target',
      '0006_upload_completion',
      '--backup-checkpoint',
      'local-entry-checkpoint-20261022',
    ]),
  )
  expect(rerun.applied).toEqual([])
  expect(await readFile(receiptPath, 'utf8')).toBe(receiptBefore)

  const drifted = runtime.parseKnowledgeMigrateConfig(env, [
    '--expected',
    '0000_knowledge_base',
    '--target',
    '0006_upload_completion',
    '--backup-checkpoint',
    'local-entry-checkpoint-20261022',
  ])
  await expect(runtime.migrateKnowledgeDatabase(drifted)).rejects.toThrow(/Refusing/)

  await writeFile(receiptPath, receiptBefore.replace('0006_upload_completion', '0005_upload_x'))
  await expect(runtime.migrateKnowledgeDatabase(drifted)).rejects.toThrow(/Refusing/)
  await writeFile(receiptPath, receiptBefore)
})