import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as runtime from '../src/runtime'

const environment = {
  KNOWLEDGE_ENVIRONMENT: 'isolated_test',
  KNOWLEDGE_DATABASE_NAME: 'knowledge_migrate',
  KNOWLEDGE_MIGRATOR_DATABASE_ROLE: 'knowledge_migrator',
  KNOWLEDGE_MIGRATOR_DATABASE_URL:
    'postgresql://knowledge_migrator:synthetic-pass@127.0.0.1:55432/knowledge_migrate',
  KNOWLEDGE_MIGRATE_RECEIPT_DIR: '/var/lib/fangtang-knowledge/receipts',
}

const invocation = [
  '--expected',
  'EMPTY',
  '--target',
  '0001_beta',
  '--backup-checkpoint',
  'local-checkpoint-20261022',
]

const journal = {
  version: '7',
  dialect: 'postgresql',
  entries: [
    { idx: 0, version: '7', when: 1, tag: '0000_alpha', breakpoints: true },
    { idx: 1, version: '7', when: 2, tag: '0001_beta', breakpoints: true },
  ],
}

const files = new Map<string, string>([
  ['journal', JSON.stringify(journal)],
  ['sql:0000_alpha', '-- alpha\nSELECT 1;'],
  ['sql:0001_beta', '-- beta\nSELECT 2;'],
  ['snapshot:0', '{"id":"snap-0"}'],
  ['snapshot:1', '{"id":"snap-1"}'],
])

function fakeIo(overrides: Partial<Record<string, string | null>> = {}) {
  const queries: { text: string }[] = []
  const written: { key: string; contents: string }[] = []
  let failOn: string | undefined
  const io = {
    readFile: async (key: string, name?: string) => {
      const full = name === undefined ? key : `${key}:${name}`
      if (Object.hasOwn(overrides, full)) return overrides[full] as string | null
      if (name === undefined && Object.hasOwn(overrides, key)) return overrides[key] as string | null
      return files.get(full) ?? null
    },
    writeFile: async (key: string, contents: string) => {
      written.push({ key, contents })
    },
    connect: async () => ({
      query: async (text: string): Promise<{ rows: { existing: { oid: number } | null }[] }> => {
        queries.push({ text })
        if (failOn !== undefined && text.includes(failOn)) throw new Error('boom')
        if (text.includes('to_regnamespace')) return { rows: [{ existing: null }] }
        return { rows: [] }
      },
      end: async () => {},
    }),
  }
  return { io, queries, written, setFailOn: (marker: string) => (failOn = marker) }
}

const hashOf = (content: string) => createHash('sha256').update(content).digest('hex')

const receiptFor = (revision: string, contents: Record<string, string>) =>
  JSON.stringify({
    database: 'knowledge_migrate',
    revision,
    appliedAt: '2026-10-22T00:00:00.000Z',
    backupCheckpoint: 'local-checkpoint-20261022',
    artifacts: Object.entries(contents).map(([name, content]) => ({
      name,
      sha256: hashOf(content),
    })),
  })

describe('parseKnowledgeMigrateConfig', () => {
  it('requires independent migrator credentials, explicit revisions and a backup checkpoint', () => {
    const config = runtime.parseKnowledgeMigrateConfig(environment, invocation)
    expect(config).toMatchObject({
      role: 'migrator',
      expectedRevision: 'EMPTY',
      targetRevision: '0001_beta',
      backupCheckpoint: 'local-checkpoint-20261022',
      database: { user: 'knowledge_migrator', database: 'knowledge_migrate' },
    })
  })

  const unsafeInvocations: string[][] = [
    ['--expected', 'EMPTY', '--target', '0001_beta'],
    ['--expected', 'EMPTY', '--backup-checkpoint', 'local-checkpoint-20261022'],
    ['--target', '0001_beta', '--backup-checkpoint', 'local-checkpoint-20261022'],
    [...invocation, '--extra', 'value'],
    ['--expected', 'CURRENT', '--target', '0001_beta', '--backup-checkpoint', 'local-checkpoint'],
    ['--expected', 'EMPTY', '--target', 'latest', '--backup-checkpoint', 'local-checkpoint-2026'],
    ['--expected', 'EMPTY', '--target', '0001_beta', '--backup-checkpoint', 'short'],
    ['--expected', 'EMPTY', '--target', '0001_beta', '--backup-checkpoint', 'has\tnul'],
  ]
  for (const argv of unsafeInvocations) {
    it(`refuses incomplete or unsafe invocations: ${JSON.stringify(argv)}`, () => {
      expect(() => runtime.parseKnowledgeMigrateConfig(environment, argv)).toThrow('NOT_CONFIGURED')
    })
  }

  it.each([
    { KNOWLEDGE_MIGRATOR_DATABASE_URL: undefined },
    { KNOWLEDGE_MIGRATOR_DATABASE_ROLE: undefined },
    { KNOWLEDGE_MIGRATE_RECEIPT_DIR: undefined },
    { KNOWLEDGE_MIGRATE_RECEIPT_DIR: 'receipts' },
    {
      KNOWLEDGE_MIGRATOR_DATABASE_URL:
        'postgresql://knowledge_migrator:synthetic-pass@127.0.0.1:55432/knowledge_other',
    },
    {
      KNOWLEDGE_MIGRATOR_DATABASE_URL:
        'postgresql://knowledge_worker:synthetic-pass@127.0.0.1:55432/knowledge_migrate',
    },
  ])('refuses missing or borrowed migrator identity %#', (overrides) => {
    expect(() =>
      runtime.parseKnowledgeMigrateConfig({ ...environment, ...overrides }, invocation),
    ).toThrow('NOT_CONFIGURED')
  })
})

describe('migrateKnowledgeDatabase', () => {
  it('applies pending generated migrations in journal order under an advisory lock and records a receipt', async () => {
    const fake = fakeIo()
    const outcome = await runtime.migrateKnowledgeDatabase(
      runtime.parseKnowledgeMigrateConfig(environment, invocation),
      fake.io,
    )
    expect(outcome).toEqual({
      applied: ['0000_alpha', '0001_beta'],
      revision: '0001_beta',
    })
    expect(fake.queries.some((entry) => entry.text.includes('pg_advisory_lock'))).toBe(true)
    expect(fake.queries.some((entry) => entry.text.includes('pg_advisory_unlock'))).toBe(true)
    expect(fake.queries.some((entry) => entry.text.includes('SELECT 1;'))).toBe(true)
    expect(fake.queries.some((entry) => entry.text.includes('SELECT 2;'))).toBe(true)
    expect(fake.written).toHaveLength(1)
    const receipt = JSON.parse(fake.written[0].contents)
    expect(receipt).toMatchObject({
      database: 'knowledge_migrate',
      revision: '0001_beta',
      backupCheckpoint: 'local-checkpoint-20261022',
    })
    expect(receipt.artifacts).toHaveLength(2)
  })

  it('refuses a stale receipt when the target schema does not exist', async () => {
    const fake = fakeIo({
      receipt: receiptFor('0001_beta', {
        'drizzle/0000_alpha.sql': 'aa',
        'drizzle/0001_beta.sql': 'bb',
      }),
    })
    await expect(
      runtime.migrateKnowledgeDatabase(
        runtime.parseKnowledgeMigrateConfig(environment, invocation),
        fake.io,
      ),
    ).rejects.toThrow(/Refusing/)
    expect(fake.written).toHaveLength(0)
  })

  it('refuses when the schema exists but the receipt revision does not match the expectation', async () => {
    const fake = fakeIo()
    fake.io.connect = async () => ({
      query: async (text: string) => {
        fake.queries.push({ text })
        if (text.includes('to_regnamespace')) return { rows: [{ existing: { oid: 1 } }] }
        return { rows: [] }
      },
      end: async () => {},
    })
    await expect(
      runtime.migrateKnowledgeDatabase(
        runtime.parseKnowledgeMigrateConfig(environment, invocation),
        fake.io,
      ),
    ).rejects.toThrow(/Refusing/)
  })

  it('refuses when a previously applied artifact hash no longer matches the receipt', async () => {
    const fake = fakeIo({
      receipt: receiptFor('0000_alpha', { 'drizzle/0000_alpha.sql': 'tampered' }),
    })
    fake.io.connect = async () => ({
      query: async (text: string) => {
        fake.queries.push({ text })
        if (text.includes('to_regnamespace')) return { rows: [{ existing: { oid: 1 } }] }
        return { rows: [] }
      },
      end: async () => {},
    })
    await expect(
      runtime.migrateKnowledgeDatabase(
        runtime.parseKnowledgeMigrateConfig(environment, [
          '--expected',
          '0000_alpha',
          '--target',
          '0001_beta',
          '--backup-checkpoint',
          'local-checkpoint-20261022',
        ]),
        fake.io,
      ),
    ).rejects.toThrow(/Refusing/)
    expect(fake.written).toHaveLength(0)
  })

  it('stops on the first failing migration, rolls back and applies nothing further', async () => {
    const fake = fakeIo()
    fake.setFailOn('SELECT 2;')
    await expect(
      runtime.migrateKnowledgeDatabase(
        runtime.parseKnowledgeMigrateConfig(environment, invocation),
        fake.io,
      ),
    ).rejects.toThrow('boom')
    expect(fake.queries.filter((entry) => entry.text.includes('ROLLBACK')).length).toBe(1)
    expect(fake.queries.some((entry) => entry.text.includes('SELECT 2;'))).toBe(true)
    expect(fake.written).toHaveLength(0)
  })

  it('treats an already current revision as a verified no-op without rewriting the receipt', async () => {
    const receipt = receiptFor('0001_beta', {
      'drizzle/0000_alpha.sql': files.get('sql:0000_alpha') as string,
      'drizzle/0001_beta.sql': files.get('sql:0001_beta') as string,
    })
    const fake = fakeIo({ receipt })
    fake.io.connect = async () => ({
      query: async (text: string) => {
        fake.queries.push({ text })
        if (text.includes('to_regnamespace')) return { rows: [{ existing: { oid: 1 } }] }
        return { rows: [] }
      },
      end: async () => {},
    })
    const outcome = await runtime.migrateKnowledgeDatabase(
      runtime.parseKnowledgeMigrateConfig(environment, [
        '--expected',
        '0001_beta',
        '--target',
        '0001_beta',
        '--backup-checkpoint',
        'local-checkpoint-20261022',
      ]),
      fake.io,
    )
    expect(outcome).toEqual({ applied: [], revision: '0001_beta' })
    expect(fake.written).toHaveLength(0)
  })

  it('refuses a journal whose entries are inconsistent with the generated artifacts', async () => {
    const broken = {
      version: '7',
      dialect: 'postgresql',
      entries: [
        { idx: 0, version: '7', when: 1, tag: '0000_alpha', breakpoints: true },
        { idx: 2, version: '7', when: 2, tag: '0001_beta', breakpoints: true },
      ],
    }
    const fake = fakeIo({ journal: JSON.stringify(broken) })
    await expect(
      runtime.migrateKnowledgeDatabase(
        runtime.parseKnowledgeMigrateConfig(environment, invocation),
        fake.io,
      ),
    ).rejects.toThrow(/Refusing/)
  })

  it('refuses a target revision that the journal does not contain', async () => {
    const fake = fakeIo()
    await expect(
      runtime.migrateKnowledgeDatabase(
        runtime.parseKnowledgeMigrateConfig(environment, [
          '--expected',
          'EMPTY',
          '--target',
          '0009_ghost',
          '--backup-checkpoint',
          'local-checkpoint-20261022',
        ]),
        fake.io,
      ),
    ).rejects.toThrow(/Refusing/)
  })
})