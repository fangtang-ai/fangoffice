import { deny } from '../errors'
import type { KnowledgeTransactionPool } from './transaction'

export type KnowledgeGcApplier = {
  collectPurgedBuild: (
    ownerId: string,
    buildId: string,
    now?: Date,
  ) => Promise<'PURGED' | 'REPLAY'>
}

// B7物理GC入口：终结对象的封存推进与物理负债清算走knowledge_gc专用授权；
// 收敛owner由调用给定且SQL侧事务级绑定，REPLAY视为已清算的历史重放，失败不提交不假报。
export function createKnowledgeGcApplier(pool: KnowledgeTransactionPool): KnowledgeGcApplier {
  return {
    collectPurgedBuild: async (ownerId, buildId, now = new Date()) => {
      const client = await pool.connect().catch(() => deny('SERVICE_UNAVAILABLE'))
      let status: unknown
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        const { rows } = await client.query(
          'SELECT knowledge.collect_purged_build($1, $2, $3) AS status',
          [ownerId, buildId, now],
        )
        status = (rows[0] as { status?: unknown } | undefined)?.status
        await client.query('COMMIT')
      } catch {
        await client.query('ROLLBACK').catch(() => {})
        status = 'SERVICE_UNAVAILABLE'
      } finally {
        client.release(false)
      }
      // deny在事务块外抛出，拒绝映射不会被兜底catch改写成SERVICE_UNAVAILABLE。
      if (status === 'PURGED' || status === 'REPLAY') return status
      if (
        status === 'INVALID_REQUEST' ||
        status === 'NOT_FOUND' ||
        status === 'FORBIDDEN'
      )
        return deny(status)
      return deny('SERVICE_UNAVAILABLE')
    },
  }
}