import { deny } from '../errors'
import type { KnowledgePrincipal } from '../identity'
import { withKnowledgeTransaction, type KnowledgeTransactionPool } from './transaction'

export type KnowledgeFailureApplier = {
  failBuildAttempt: (
    buildId: string,
    jobId: string,
    retryCount: number,
    errorCode: string,
  ) => Promise<'FAILED' | 'REPLAY'>
  expireStaleOperations: () => Promise<number>
}

// B5失败收敛入口：worker上报attempt失败与维护扫描过期位都从这里走，
// 与取消共用SQL侧权威收敛；REPLAY视为已收敛的历史重放，绝不复活旧代数。
export function createKnowledgeFailureApplier(
  pool: KnowledgeTransactionPool,
  principal: KnowledgePrincipal,
): KnowledgeFailureApplier {
  return {
    failBuildAttempt: (buildId, jobId, retryCount, errorCode) =>
      withKnowledgeTransaction(pool, principal, async (transaction) => {
        const { rows } = await transaction.query(
          'SELECT knowledge.fail_current_build_attempt($1, $2, $3, $4) AS status',
          [buildId, jobId, retryCount, errorCode],
        )
        const status = (rows[0] as { status?: unknown } | undefined)?.status
        if (status === 'FAILED' || status === 'REPLAY') return status
        if (
          status === 'INVALID_REQUEST' ||
          status === 'UNAUTHENTICATED' ||
          status === 'NOT_FOUND' ||
          status === 'FORBIDDEN'
        )
          return deny(status)
        return deny('SERVICE_UNAVAILABLE')
      }),
    expireStaleOperations: () =>
      withKnowledgeTransaction(pool, principal, async (transaction) => {
        const { rows } = await transaction.query(
          'SELECT knowledge.expire_owner_stale_operations() AS converged',
        )
        const converged = (rows[0] as { converged?: unknown } | undefined)?.converged
        if (typeof converged === 'number') return converged
        return deny('SERVICE_UNAVAILABLE')
      }),
  }
}