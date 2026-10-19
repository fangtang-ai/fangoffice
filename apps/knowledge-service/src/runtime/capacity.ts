import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'

export interface CapacityReservationRequest {
  operationId: string
  chunks: bigint
  physicalBytes: bigint
  expiresAt: Date
}

export async function reserveInitialCapacity(
  transaction: KnowledgeTransaction,
  input: CapacityReservationRequest,
) {
  return reserveCapacity(transaction, input, 'initial')
}

export async function reserveReplacementCapacity(
  transaction: KnowledgeTransaction,
  input: CapacityReservationRequest,
) {
  return reserveCapacity(transaction, input, 'replacement')
}

async function reserveCapacity(
  transaction: KnowledgeTransaction,
  input: CapacityReservationRequest,
  kind: 'initial' | 'replacement',
) {
  if (
    typeof input.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.operationId) ||
    [input.chunks, input.physicalBytes].some(
      (value) => typeof value !== 'bigint' || value < 0n || value > 9223372036854775807n,
    ) ||
    !(input.expiresAt instanceof Date) ||
    !Number.isFinite(input.expiresAt.getTime())
  )
    deny('INVALID_REQUEST')
  // owner 与原文字节由可信事务/数据库事实派生，调用方不能覆盖归属或借用旧容量。
  const { rows } = await transaction.query(
    `SELECT knowledge.reserve_${kind}_capacity($1, $2, $3, $4) AS status`,
    [
      input.operationId,
      input.chunks.toString(),
      input.physicalBytes.toString(),
      input.expiresAt.toISOString(),
    ],
  )
  const status = (rows[0] as { status?: unknown } | undefined)?.status
  switch (status) {
    case 'RESERVED':
    case 'REPLAY':
      return { replayed: status === 'REPLAY' }
    case 'INVALID_REQUEST':
    case 'UNAUTHENTICATED':
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'NOT_CONFIGURED':
    case 'QUOTA_EXCEEDED':
    case 'VERSION_CONFLICT':
      return deny(status)
    default:
      return deny('SERVICE_UNAVAILABLE')
  }
}
