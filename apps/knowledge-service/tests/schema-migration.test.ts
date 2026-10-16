import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { expect, it, onTestFinished } from 'vitest'
import { primaryColumns, schemaTables } from './schema-fixtures'

const execute = promisify(execFile)
const directory = fileURLToPath(new URL('../', import.meta.url))
const tableNames = [
  'kb_billing_receipts',
  'kb_builds',
  'kb_chunk_embeddings',
  'kb_chunk_sources',
  'kb_chunks',
  'kb_documents',
  'kb_evidence_items',
  'kb_evidence_manifests',
  'kb_index_profiles',
  'kb_metering_events',
  'kb_operations',
  'kb_quotas',
  'kb_reservations',
  'kb_source_units',
  'kb_spaces',
  'kb_versions',
]

it('defines exactly 16 knowledge tables with non-null owners and valid non-partial FK targets', () => {
  expect(schemaTables.map((table) => getTableConfig(table).name).sort()).toEqual(tableNames)
  for (const table of schemaTables) {
    const config = getTableConfig(table)
    expect(config.schema).toBe('knowledge')
    if (config.name !== 'kb_index_profiles') {
      expect(config.columns.find((column) => column.name === 'owner_id')).toMatchObject({
        notNull: true,
        dataType: 'string',
      })
    }
    for (const key of config.foreignKeys) {
      const reference = key.reference()
      const target = getTableConfig(reference.foreignTable)
      const uniqueTargets = [
        primaryColumns(reference.foreignTable),
        ...target.uniqueConstraints.map((constraint) =>
          constraint.columns.map((column) => column.name),
        ),
      ]
      expect(uniqueTargets, key.getName()).toContainEqual(
        reference.foreignColumns.map((column) => column.name),
      )
      expect(key.getName().length).toBeLessThanOrEqual(63)
      expect(key.onDelete).toBe('no action')
      expect(key.onUpdate).toBe('no action')
    }
  }
})

it('generates identical offline SQL and snapshot metadata without credentials or runtime imports', async () => {
  const source = await readFile(join(directory, 'drizzle.config.ts'), 'utf8')
  expect(source).not.toMatch(/dotenv|process\.env|dbCredentials|DB_|runtime|provider/)
  const generated = await readdir(join(directory, 'drizzle'))
  const sqlFile = generated.find((name) => name.endsWith('.sql'))
  expect(sqlFile).toBe('0000_knowledge_base.sql')
  if (!sqlFile) throw new Error('Missing generated SQL')
  const sql = await readFile(join(directory, 'drizzle', sqlFile), 'utf8')
  expect(
    [...sql.matchAll(/CREATE TABLE "knowledge"\."([^"]+)"/g)].map((match) => match[1]).sort(),
  ).toEqual(tableNames)
  expect(sql).not.toMatch(
    /CREATE EXTENSION|CREATE ROLE|MATCH FULL|CASCADE|DEFERRABLE|"pgboss"|"public"|billing_users/,
  )
  const temporary = await mkdtemp(join(tmpdir(), 'fangoffice-knowledge-schema-'))
  onTestFinished(async () => {
    const [target, parent] = await Promise.all([realpath(temporary), realpath(tmpdir())])
    if (dirname(target) !== parent || !basename(target).startsWith('fangoffice-knowledge-schema-'))
      throw new Error('Refusing unexpected schema test cleanup')
    await rm(target, { recursive: true, force: true })
  })
  const output = join(temporary, 'generated')
  const config = join(temporary, 'drizzle.config.json')
  await writeFile(
    config,
    JSON.stringify({
      dialect: 'postgresql',
      schema: join(directory, 'src/schema/index.ts').replaceAll('\\', '/'),
      out: './generated',
      schemaFilter: ['knowledge'],
    }),
  )
  const cli = fileURLToPath(new URL('../../../node_modules/drizzle-kit/bin.cjs', import.meta.url))
  const result = await execute(
    process.execPath,
    [cli, 'generate', '--config', config, '--name', 'knowledge_base'],
    { cwd: temporary, timeout: 20000 },
  ).catch((error: unknown) => {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error)
      throw new Error(`${error.message}\n${String(error.stdout)}\n${String(error.stderr)}`)
    throw error
  })
  expect(result.stdout).toContain('16 tables')
  expect(await readFile(join(output, sqlFile), 'utf8')).toBe(sql)
  const snapshot = JSON.parse(
    await readFile(join(directory, 'drizzle/meta/0000_snapshot.json'), 'utf8'),
  ) as Record<string, unknown>
  const regenerated = JSON.parse(
    await readFile(join(output, 'meta/0000_snapshot.json'), 'utf8'),
  ) as Record<string, unknown>
  const { id: snapshotId, ...snapshotBody } = snapshot
  const { id: regeneratedId, ...regeneratedBody } = regenerated
  expect(snapshotId).toEqual(expect.any(String))
  expect(regeneratedId).toEqual(expect.any(String))
  expect(regeneratedBody).toEqual(snapshotBody)
  const journal = JSON.parse(
    await readFile(join(directory, 'drizzle/meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string; breakpoints: boolean }[] }
  expect(journal.entries).toEqual([
    expect.objectContaining({ idx: 0, tag: '0000_knowledge_base', breakpoints: true }),
  ])
  await execute(process.execPath, [cli, 'check', '--config', config], {
    cwd: temporary,
    timeout: 20000,
  })
}, 30000)

it('includes knowledge schema creation in the candidate for an empty isolated database', async () => {
  const sql = await readFile(join(directory, 'drizzle/0000_knowledge_base.sql'), 'utf8')
  expect(sql.includes('CREATE SCHEMA "knowledge";')).toBe(true)
})
