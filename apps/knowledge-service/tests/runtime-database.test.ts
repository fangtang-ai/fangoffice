import { expect, it, vi } from 'vitest'
import { createKnowledgeDatabase } from '../src/runtime'
import { apiConfig } from './runtime-fixtures'

function databaseFixture(overrides: Record<string, unknown> = {}) {
  let idleError = () => {}
  const identity = {
    database: 'knowledge_synthetic',
    role: 'knowledge_api',
    session_role: 'knowledge_api',
    superuser: false,
    bypass_rls: false,
    create_role: false,
    create_database: false,
    replication: false,
    ...overrides,
  }
  const pool = {
    query: vi.fn(async (_sql: string) => ({ rows: [identity] })),
    end: vi.fn(async () => {}),
    on: (_event: 'error', listener: () => void) => {
      idleError = listener
    },
  }
  const database = createKnowledgeDatabase(apiConfig().database, () => pool)
  return { database, pool, idleError: () => idleError() }
}

it('verifies a dedicated unprivileged database identity using only a read-only probe', async () => {
  const { database, pool } = databaseFixture()
  expect(database.healthy()).toBe(false)
  await database.verify()
  expect(database.healthy()).toBe(true)
  expect(pool.query).toHaveBeenCalledOnce()
  expect(pool.query.mock.calls[0]?.[0]).toMatch(/^\s*SELECT\b/i)
  expect(pool.query.mock.calls[0]?.[0]).not.toMatch(/\b(CREATE|ALTER|DROP|BEGIN|migrate)\b/i)
  await database.close()
  expect(database.healthy()).toBe(false)
})

it.each([
  { database: 'business' },
  { role: 'business_api' },
  { session_role: 'postgres' },
  { superuser: true },
  { bypass_rls: true },
  { create_role: true },
  { create_database: true },
  { replication: true },
])('refuses a mismatched or privileged database identity without leaking it', async (identity) => {
  const { database } = databaseFixture(identity)
  try {
    await expect(database.verify()).rejects.toThrow('NOT_CONFIGURED')
    expect(database.healthy()).toBe(false)
  } finally {
    await database.close()
  }
})

it('marks an idle-driver failure unhealthy rather than emitting an unhandled error', async () => {
  const { database, idleError } = databaseFixture()
  await database.verify()
  idleError()
  expect(database.signal.aborted).toBe(true)
  expect(database.healthy()).toBe(false)
  await expect(database.verify()).rejects.toThrow('SERVICE_UNAVAILABLE')
  await database.close()
})

it('closes once and prevents another probe after closure', async () => {
  const { database, pool } = databaseFixture()
  await Promise.all([database.close(), database.close()])
  expect(pool.end).toHaveBeenCalledOnce()
  await expect(database.verify()).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(pool.query).not.toHaveBeenCalled()
})

it('sanitizes connection diagnostics and never reports a failed probe healthy', async () => {
  const { database, pool } = databaseFixture()
  pool.query.mockRejectedValue(new Error('synthetic-private-dsn-password'))
  try {
    await expect(database.verify()).rejects.toThrow('SERVICE_UNAVAILABLE')
  } finally {
    await database.close()
  }
  expect(database.healthy()).toBe(false)
})

it('does not resurrect readiness when an in-flight probe finishes after closure', async () => {
  const { database, pool } = databaseFixture()
  const result = await pool.query('synthetic fixture only')
  pool.query.mockClear()
  let release!: (value: typeof result) => void
  pool.query.mockReturnValue(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const verification = database.verify()
  await database.close()
  release(result)
  await expect(verification).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(database.healthy()).toBe(false)
})

it('sanitizes a synchronous driver-construction error', () => {
  expect(() =>
    createKnowledgeDatabase(apiConfig().database, () => {
      throw new Error('synthetic-private-dsn')
    }),
  ).toThrow('SERVICE_UNAVAILABLE')
})
