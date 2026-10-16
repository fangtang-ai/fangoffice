import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'

// B4/B6 队列信封校验：载荷只携带引用标识，所有权与 attempt 绑定一律由
// (owner, id, job_id, retry_count) 复合键在可信事实表上重建；RLS 用信封 owner
// 约束可见行，任何分量错误都表现为 0 行并统一拒绝（NOT_FOUND），不泄露存在性。
// 状态不匹配（已结算/已封存/非排队中）属于被禁止的 claim（FORBIDDEN）。

export interface QueueEnvelope {
  ownerId: string
  operationId: string
  buildId: string
  receiptId: string
}

export interface QueueJobRef {
  id: string
  retryCount: number
}

export interface QueueBuildContext {
  // 信封 owner：RLS 已约束它与行 owner 一致；worker 写入列时只能用它，
  // 不能从别处重新引入 owner 假设。
  ownerId: string
  buildId: string
  operationId: string
  documentId: string
  versionId: string
  indexProfileId: string
  expectedGeneration: number
  operationKind: string
  operationPhase: string
  receiptStatus: string
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseQueueEnvelope(data: unknown): QueueEnvelope {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) deny('INVALID_REQUEST')
  const candidate = data as Record<string, unknown>
  const ownerId = candidate.ownerId
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 512 || ownerId.trim() !== ownerId)
    deny('INVALID_REQUEST')
  const ids: Partial<QueueEnvelope> = {}
  for (const key of ['operationId', 'buildId', 'receiptId'] as const) {
    const value = candidate[key]
    if (typeof value !== 'string' || !uuid.test(value)) deny('INVALID_REQUEST')
    ids[key] = value
  }
  if (Object.keys(candidate).length !== 4) deny('INVALID_REQUEST')
  return { ownerId, ...ids } as QueueEnvelope
}

export async function resolveQueueBuild(
  transaction: KnowledgeTransaction,
  job: QueueJobRef,
  envelope: QueueEnvelope,
): Promise<QueueBuildContext> {
  const { rows } = await transaction.query(
    `SELECT b.id::text AS build_id, b.operation_id::text AS operation_id,
            b.document_id::text AS document_id, b.version_id::text AS version_id,
            b.index_profile_id::text AS index_profile_id, b.status::text AS status,
            b.gc_state::text AS gc_state, b.expected_generation::text AS expected_generation,
            o.kind::text AS operation_kind, o.phase::text AS operation_phase,
            r.status::text AS receipt_status
       FROM knowledge.kb_builds b
       JOIN knowledge.kb_operations o
         ON o.owner_id = b.owner_id AND o.id = b.operation_id
       LEFT JOIN knowledge.kb_billing_receipts r
         ON r.owner_id = b.owner_id AND r.id = $3
      WHERE b.owner_id = $1 AND b.id = $2 AND b.job_id = $4 AND b.retry_count = $5
        AND b.operation_id = $6 AND b.gc_state = 'live'`,
    [
      envelope.ownerId,
      envelope.buildId,
      envelope.receiptId,
      job.id,
      job.retryCount,
      envelope.operationId,
    ],
  )
  const row = rows[0] as
    | {
        build_id: string
        operation_id: string
        document_id: string
        version_id: string
        index_profile_id: string
        status: string
        gc_state: string
        expected_generation: string
        operation_kind: string
        operation_phase: string
        receipt_status: string | null
      }
    | undefined
  if (!row) deny('NOT_FOUND')
  if (row.status !== 'building' || row.gc_state !== 'live' || row.operation_phase !== 'queued')
    deny('FORBIDDEN')
  if (row.receipt_status === null) deny('NOT_FOUND')
  if (row.receipt_status !== 'pending') deny('FORBIDDEN')
  return {
    ownerId: envelope.ownerId,
    buildId: row.build_id,
    operationId: row.operation_id,
    documentId: row.document_id,
    versionId: row.version_id,
    indexProfileId: row.index_profile_id,
    expectedGeneration: Number(row.expected_generation),
    operationKind: row.operation_kind,
    operationPhase: row.operation_phase,
    receiptStatus: row.receipt_status,
  }
}
