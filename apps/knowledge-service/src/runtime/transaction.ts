import { deny, KnowledgePolicyError } from '../errors'
import { requireKnowledgePrincipal, type KnowledgePrincipal } from '../identity'

export interface KnowledgeTransaction {
  query: (
    statement: string,
    values?: unknown[],
  ) => Promise<{
    rows: unknown[]
    rowCount: number | null
  }>
}

export interface KnowledgeTransactionClient extends KnowledgeTransaction {
  release: (destroy: boolean) => void
  on: (event: 'error', listener: () => void) => unknown
  removeListener: (event: 'error', listener: () => void) => unknown
}

export interface KnowledgeTransactionPool {
  connect: () => Promise<KnowledgeTransactionClient>
}

export async function withKnowledgeTransaction<Result>(
  pool: KnowledgeTransactionPool,
  principal: KnowledgePrincipal,
  work: (transaction: KnowledgeTransaction) => Promise<Result>,
  { now = Date.now }: { now?: () => number } = {},
) {
  requireKnowledgePrincipal(principal, now())
  const client = await pool.connect().catch(() => deny('SERVICE_UNAVAILABLE'))
  let begun = false
  let active = false
  let destroy = true
  let committing = false
  let failed = false
  let broken = false
  let pending = 0
  const onError = () => {
    broken = true
    failed = true
  }
  try {
    client.on('error', onError)
    requireKnowledgePrincipal(principal, now())
    const identity = await client.query(
      "SELECT NULLIF(current_setting('knowledge.owner_id', true), '') AS owner_id",
    )
    const row = identity.rows[0]
    if (
      identity.rows.length !== 1 ||
      typeof row !== 'object' ||
      row === null ||
      !('owner_id' in row) ||
      row.owner_id !== null
    )
      deny('SERVICE_UNAVAILABLE')
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    begun = true
    await client.query("SELECT set_config('knowledge.owner_id', $1, true)", [principal.ownerId])
    requireKnowledgePrincipal(principal, now())
    if (failed) deny('SERVICE_UNAVAILABLE')
    active = true
    const result = await work({
      async query(statement, values) {
        if (!active || failed) deny('SERVICE_UNAVAILABLE')
        pending += 1
        try {
          requireKnowledgePrincipal(principal, now())
          return await client.query(statement, values)
        } catch (error) {
          // Even a swallowed statement error must prevent COMMIT of an aborted transaction.
          failed = true
          if (error instanceof KnowledgePolicyError) throw error
          deny('SERVICE_UNAVAILABLE')
        } finally {
          pending -= 1
        }
      },
    })
    active = false
    if (failed || pending !== 0) deny('SERVICE_UNAVAILABLE')
    requireKnowledgePrincipal(principal, now())
    committing = true
    await client.query('COMMIT')
    begun = false
    destroy = broken
    if (broken) deny('SERVICE_UNAVAILABLE')
    return result
  } catch (error) {
    active = false
    // Failed COMMIT is ambiguous; pending queries and failed rollback also require eviction.
    if (begun) {
      try {
        await client.query('ROLLBACK')
        destroy = broken || committing || pending !== 0
      } catch {}
    }
    if (error instanceof KnowledgePolicyError) throw error
    deny('SERVICE_UNAVAILABLE')
  } finally {
    active = false
    client.removeListener('error', onError)
    client.release(destroy)
  }
}
