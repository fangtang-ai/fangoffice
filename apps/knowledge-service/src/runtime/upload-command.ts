import { KnowledgeContractError } from '@genoffice/knowledge-contract'
import { deny } from '../errors'
import type { KnowledgeTransaction } from './transaction'

export function uploadInput<Parsed>(parse: (value: unknown) => Parsed, value: unknown) {
  try {
    return parse(value)
  } catch (error) {
    if (error instanceof KnowledgeContractError) deny('INVALID_REQUEST')
    throw error
  }
}

export function uploadFact<Parsed>(parse: (value: unknown) => Parsed, value: unknown) {
  try {
    return parse(value)
  } catch (error) {
    if (error instanceof KnowledgeContractError) deny('SERVICE_UNAVAILABLE')
    throw error
  }
}

export async function uploadCommand(
  transaction: KnowledgeTransaction,
  statement: string,
  values: unknown[],
) {
  const { rows } = await transaction.query(statement, values)
  const status = (rows[0] as { status?: unknown } | undefined)?.status
  switch (status) {
    case 'CREATED':
    case 'PREPARED':
    case 'LOCKED':
    case 'COMPLETED':
      return false
    case 'REPLAY':
      return true
    case 'INVALID_REQUEST':
    case 'UNAUTHENTICATED':
    case 'NOT_FOUND':
    case 'NOT_CONFIGURED':
    case 'FORBIDDEN':
    case 'VERSION_CONFLICT':
    case 'QUOTA_EXCEEDED':
      return deny(status)
    default:
      return deny('SERVICE_UNAVAILABLE')
  }
}
