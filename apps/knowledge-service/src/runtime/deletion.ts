import { deny, KnowledgePolicyError } from '../errors'
import { createKnowledgePrincipal, requireKnowledgePrincipal, type KnowledgeAuthority, type KnowledgePrincipal } from '../identity'
import {
  deletionIntentIdentity, parseKnowledgeDeletionIntent, parseKnowledgeDeletionRequest,
  type KnowledgeDeletionApplier, type KnowledgeDeletionIntent, type KnowledgeDeletionJournal,
  type KnowledgeDeletionWriter,
} from '../deletion/intent'
import { withKnowledgeTransaction, type KnowledgeTransaction, type KnowledgeTransactionPool } from './transaction'

export async function deleteKnowledgeScope(
  principal: KnowledgePrincipal,
  request: unknown,
  journal: KnowledgeDeletionWriter,
  apply: KnowledgeDeletionApplier,
  { now = Date.now }: { now?: () => number } = {},
) {
  const recordedAt = now()
  requireKnowledgePrincipal(principal, recordedAt)
  const input = parseKnowledgeDeletionRequest(request)
  const intended = parseKnowledgeDeletionIntent({ schemaVersion: 1, ...input, ownerId: principal.ownerId, recordedAt })
  try {
    // 日志在事务外持久确认；PG失败保留意图，绝不以回滚/撤销日志补偿已受理删除。
    const recorded = parseKnowledgeDeletionIntent(await journal.append(intended))
    if (deletionIntentIdentity(recorded) !== deletionIntentIdentity(intended)) deny('SERVICE_UNAVAILABLE')
    requireKnowledgePrincipal(principal, now())
    const result = await apply(recorded)
    if (result !== 'DELETED' && result !== 'PENDING') deny('SERVICE_UNAVAILABLE')
    return { intentId: recorded.id, phase: result === 'DELETED' ? 'deleted' as const : 'deleting' as const }
  } catch (error) {
    if (error instanceof KnowledgePolicyError) throw error
    deny('SERVICE_UNAVAILABLE')
  }
}

export async function applyKnowledgeDeletionIntent(
  transaction: KnowledgeTransaction,
  rawIntent: unknown,
): Promise<'DELETED' | 'PENDING'> {
  const intent = parseKnowledgeDeletionIntent(rawIntent)
  const scope = intent.scope
  const { rows } = await transaction.query(
    'SELECT knowledge.apply_deletion_intent($1, $2, $3, $4) AS status',
    [
      intent.id,
      scope.kind,
      scope.kind === 'owner' ? null : scope.spaceId ?? null,
      scope.kind === 'document' ? scope.documentId : null,
    ],
  )
  const status = (rows[0] as { status?: unknown } | undefined)?.status
  // NOT_FOUND/REPLAY 同样视为收敛：重放历史意图绝不复活任何对象。
  if (status === 'DELETED' || status === 'REPLAY' || status === 'NOT_FOUND') return 'DELETED' as const
  if (status === 'PENDING') return 'PENDING' as const
  return deny('SERVICE_UNAVAILABLE')
}

export function createKnowledgeDeletionApplier(
  pool: KnowledgeTransactionPool,
  principal: KnowledgePrincipal,
): KnowledgeDeletionApplier {
  return (rawIntent) =>
    withKnowledgeTransaction(pool, principal, (transaction) => {
      // 重放信任边界：意图归属必须与principal一致，陌生principal不得收敛他人意图。
      if (parseKnowledgeDeletionIntent(rawIntent).ownerId !== principal.ownerId) {
        deny('SERVICE_UNAVAILABLE')
      }
      return applyKnowledgeDeletionIntent(transaction, rawIntent)
    })
}

// 启动重放以持久日志为信任锚：仅针对已确认意图按其owner收敛，短时效且不引入新权限。
export function createKnowledgeReplayPrincipal(
  ownerId: string,
  authority: KnowledgeAuthority,
  now = Date.now(),
) {
  return createKnowledgePrincipal(
    {
      issuer: authority.issuer,
      audiences: [authority.audience],
      subject: ownerId,
      expiresAt: now + 60000,
      permissions: [...(authority.requiredPermissions ?? [])],
    },
    authority,
    now,
  )
}

// 启动重放：逐条收敛已确认意图；任何一条失败都必须拒绝就绪，绝不假报已删除。
export type KnowledgeDeletionReplayApplier = (
  intent: KnowledgeDeletionIntent,
) => Promise<'DELETED' | 'PENDING'>

export async function replayKnowledgeDeletionJournal(
  journal: KnowledgeDeletionJournal,
  apply: KnowledgeDeletionReplayApplier,
) {
  let replayed = 0
  for await (const intent of journal.entries()) {
    const result = await apply(intent)
    if (result !== 'DELETED' && result !== 'PENDING') deny('SERVICE_UNAVAILABLE')
    replayed += 1
  }
  return replayed
}
