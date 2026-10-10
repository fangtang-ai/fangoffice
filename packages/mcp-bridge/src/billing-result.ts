import type { McpBillingInfo, McpCallContext, OfficeBillingProblem } from '@genoffice/agent-core'

export const MCP_BILLING_META_KEY = 'fang-tang.cn/billing'

const KNOWN_PROBLEMS = new Set([
  'insufficient_balance',
  'quota_exceeded',
  'invalid_access_token',
  'invalid_call_metadata',
  'billing_error',
  'call_in_progress',
  'reservation_expired',
  'idempotency_conflict',
  'replay_unavailable',
  'product_unavailable',
  'unknown_billing_tool',
  'scope_required',
  'dataset_not_allowed',
  'policy_not_found',
  'index_unavailable',
  'invalid_filter',
  'upstream_unavailable',
  'forbidden_origin',
  'oversize_request',
])

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function readMcpToolProblem(structured: unknown, text: string): OfficeBillingProblem {
  let value = asRecord(structured)
  if (typeof value?.code !== 'string') {
    try {
      value = asRecord(JSON.parse(text.slice(0, 8192)))
    } catch {
      value = null
    }
  }
  const code =
    typeof value?.code === 'string' && KNOWN_PROBLEMS.has(value.code)
      ? value.code
      : 'mcp_tool_error'
  const metadata = asRecord(value?.metadata) ?? value
  const dimension = metadata?.limitDimension
  const resetAt = metadata?.resetAt
  return {
    code,
    retryAllowed: code === 'call_in_progress',
    ...(code === 'quota_exceeded' && (dimension === 'minute' || dimension === 'day')
      ? { limitDimension: dimension }
      : {}),
    ...(code === 'quota_exceeded' &&
    typeof resetAt === 'string' &&
    /^\d{4}-\d\d-\d\dT/.test(resetAt) &&
    Number.isFinite(Date.parse(resetAt))
      ? { resetAt }
      : {}),
  }
}

export function mcpProblemText(problem: OfficeBillingProblem) {
  if (problem.code === 'insufficient_balance')
    return '方糖MCP 余额不足，请充值后由用户重新发起；不会自动重跑或确认到账。'
  if (problem.code === 'quota_exceeded')
    return '方糖MCP 达到安全请求限额，请等待恢复；充值不会解除该限制。'
  if (problem.code === 'invalid_access_token' || problem.code === 'account:required')
    return '方糖账号登录已失效，请重新登录。'
  if (problem.code === 'call_in_progress')
    return '方糖MCP 调用仍在处理中；如重试必须沿用原逻辑调用标识。'
  if (problem.code === 'idempotency_conflict' || problem.code === 'replay_unavailable')
    return '方糖MCP 调用标识冲突或结果不可重放，不会自动创建新调用收费。'
  return `方糖MCP 调用未完成（${problem.code}）；已停止自动重试。`
}

export function readMcpBillingMetadata(
  meta: unknown,
  context: McpCallContext,
): McpBillingInfo | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const value = (meta as Record<string, unknown>)[MCP_BILLING_META_KEY]
  if (!value || typeof value !== 'object') return undefined
  const billing = value as Record<string, unknown>
  if (
    billing.product !== 'policy_mcp' ||
    billing.aiRunId !== context.aiRunId ||
    billing.logicalCallId !== context.logicalCallId
  )
    return undefined
  const status = billing.status
  if (status !== 'settled' && status !== 'released' && status !== 'reserved') return undefined
  if (
    typeof billing.amountFen !== 'number' ||
    !Number.isSafeInteger(billing.amountFen) ||
    billing.amountFen < 0
  )
    return undefined
  return {
    ...context,
    product: 'policy_mcp',
    status,
    amountFen: billing.amountFen,
    ...(typeof billing.billingRequestId === 'string'
      ? { billingRequestId: billing.billingRequestId }
      : {}),
  }
}

export function extractMcpText(content: unknown) {
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      const record = asRecord(block)
      if (typeof record?.text === 'string') return record.text
      return record ? JSON.stringify(record) : String(block ?? '')
    })
    .filter(Boolean)
    .join('\n')
}

export function formatMcpResult(
  result: { content?: unknown; isError?: unknown; _meta?: unknown; structuredContent?: unknown },
  context?: McpCallContext,
) {
  const text = extractMcpText(result.content)
  const isError = result.isError === true
  const billed = context ? readMcpBillingMetadata(result._meta, context) : undefined
  if (context && isError) {
    const error = readMcpToolProblem(result.structuredContent, text)
    const billing: McpBillingInfo = { ...billed, ...context, product: 'policy_mcp', error }
    return { text: mcpProblemText(error), isError, billing }
  }
  return { text, isError, ...(billed ? { billing: billed } : {}) }
}
