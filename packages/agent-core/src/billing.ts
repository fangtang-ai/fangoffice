export type OfficeBillingProduct = 'office_ai' | 'policy_mcp'

export interface McpCallContext {
  aiRunId: string
  logicalCallId: string
}

export interface OfficeBillingProblem {
  code: string
  retryAllowed: boolean
  limitDimension?: 'minute' | 'day'
  resetAt?: string
}

export interface McpBillingInfo extends McpCallContext {
  product: 'policy_mcp'
  status?: 'reserved' | 'settled' | 'released'
  amountFen?: number
  billingRequestId?: string
  error?: OfficeBillingProblem
}

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i

export function isMcpCallContext(value: unknown): value is McpCallContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  return (
    typeof context.aiRunId === 'string' &&
    UUID_PATTERN.test(context.aiRunId) &&
    typeof context.logicalCallId === 'string' &&
    UUID_PATTERN.test(context.logicalCallId)
  )
}
