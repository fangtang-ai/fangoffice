import { expect, it, vi } from 'vitest'
import { withKnowledgeTransaction } from '../src/runtime'
import { KnowledgePolicyError } from '../src/errors'
import { now, principal, transactionFixture } from './runtime-transaction-fixtures'

it('runs owner-bound work on one checked-out connection and parameterizes the verified subject', async () => {
  const { pool, client } = transactionFixture()
  const result = await withKnowledgeTransaction(
    pool,
    principal(),
    async (transaction) => {
      await transaction.query('SELECT 7 AS value')
      return 'completed'
    },
    { now },
  )
  expect(result).toBe('completed')
  expect(pool.connect).toHaveBeenCalledOnce()
  expect(client.query.mock.calls).toEqual([
    ["SELECT NULLIF(current_setting('knowledge.owner_id', true), '') AS owner_id"],
    ['BEGIN ISOLATION LEVEL READ COMMITTED'],
    ["SELECT set_config('knowledge.owner_id', $1, true)", ["owner-'雪"]],
    ['SELECT 7 AS value', undefined],
    ['COMMIT'],
  ])
  expect(client.release.mock.calls).toEqual([[false]])
})

it('does not commit when a caller catches a failed statement', async () => {
  const { pool, client } = transactionFixture()
  let caught: unknown
  client.query.mockImplementation(async (statement) => {
    if (statement === 'SELECT broken') throw new Error('private-driver-diagnostic')
    return { rows: [{ owner_id: null }], rowCount: 1 }
  })
  await expect(
    withKnowledgeTransaction(
      pool,
      principal(),
      async (transaction) => {
        try {
          await transaction.query('SELECT broken')
        } catch (error) {
          caught = error
        }
        return 'must not succeed'
      },
      { now },
    ),
  ).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(caught).toBeInstanceOf(KnowledgePolicyError)
  expect(client.query.mock.calls.map(([statement]) => statement)).not.toContain('COMMIT')
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
  expect(client.release).toHaveBeenCalledWith(false)
})

it('destroys a connection after a failed commit even if a later rollback responds', async () => {
  const { pool, client } = transactionFixture()
  client.query.mockImplementation(async (statement) => {
    if (statement === 'COMMIT') throw new Error('private-ambiguous-commit')
    return { rows: [{ owner_id: null }], rowCount: 1 }
  })
  await expect(
    withKnowledgeTransaction(pool, principal(), async () => 'done', { now }),
  ).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(client.release).toHaveBeenCalledWith(true)
})

it('rejects work that leaves a query pending instead of racing it against commit', async () => {
  const { pool, client } = transactionFixture()
  let finish!: () => void
  client.query.mockImplementation(async (statement) => {
    if (statement === 'SELECT pending')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return { rows: [{ owner_id: null }], rowCount: 1 }
  })
  let pending: Promise<unknown> | undefined
  try {
    await expect(
      withKnowledgeTransaction(
        pool,
        principal(),
        async (transaction) => {
          pending = transaction.query('SELECT pending')
        },
        { now },
      ),
    ).rejects.toThrow('SERVICE_UNAVAILABLE')
    expect(client.query.mock.calls.map(([statement]) => statement)).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledWith(true)
  } finally {
    finish()
    await pending
  }
})

it('rechecks expiry after the owner binding before running user work', async () => {
  const { pool, client } = transactionFixture()
  let clock = 1000
  client.query.mockImplementation(async (statement) => {
    if (statement.includes('set_config')) clock = 2000
    return { rows: [{ owner_id: null }], rowCount: 1 }
  })
  const work = vi.fn(async () => 'not allowed')
  await expect(
    withKnowledgeTransaction(pool, principal(), work, { now: () => clock }),
  ).rejects.toThrow('UNAUTHENTICATED')
  expect(work).not.toHaveBeenCalled()
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
})

it.each(['commit', 'rollback'] as const)('expires the query handle after %s', async (outcome) => {
  const { pool, client } = transactionFixture()
  let transaction!: Parameters<Parameters<typeof withKnowledgeTransaction>[2]>[0]
  const operation = withKnowledgeTransaction(
    pool,
    principal(),
    async (handle) => {
      transaction = handle
      if (outcome === 'rollback') throw new KnowledgePolicyError('FORBIDDEN')
    },
    { now },
  )
  if (outcome === 'rollback') await expect(operation).rejects.toThrow('FORBIDDEN')
  else await operation
  const statements = client.query.mock.calls.length
  await expect(transaction.query('SELECT late')).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(client.query).toHaveBeenCalledTimes(statements)
  expect(Object.keys(transaction)).toEqual(['query'])
})
