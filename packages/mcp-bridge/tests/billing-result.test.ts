import { describe, expect, it } from 'vitest'
import type { McpCallContext, OfficeBillingProblem } from '@genoffice/agent-core'
import {
  MCP_BILLING_META_KEY,
  formatMcpResult,
  mcpProblemText,
  readMcpBillingMetadata,
  readMcpToolProblem,
} from '../src/billing-result'

const context: McpCallContext = {
  aiRunId: '018f0000-0000-7000-8000-000000000001',
  logicalCallId: '018f0000-0000-7000-8000-000000000002',
} as McpCallContext

const problem = (code: string, extra: Record<string, unknown> = {}): OfficeBillingProblem =>
  ({ code, ...extra }) as OfficeBillingProblem

const meta = (billing: Record<string, unknown>) => ({
  [MCP_BILLING_META_KEY]: {
    aiRunId: context.aiRunId,
    logicalCallId: context.logicalCallId,
    ...billing,
  },
})

describe('mcpProblemText', () => {
  it.each([
    'account:mcp-disabled',
    'insufficient_balance',
    'quota_exceeded',
    'invalid_access_token',
    'account:required',
    'call_in_progress',
    'idempotency_conflict',
    'replay_unavailable',
    'mystery_code',
  ])('uses the Fangtang brand in the user-facing message for %s', (code) => {
    expect(mcpProblemText(problem(code))).toMatch(/^方塘/)
  })

  it('maps every billing failure class to a stable user-facing sentence', () => {
    expect(mcpProblemText(problem('insufficient_balance'))).toContain('余额不足')
    expect(mcpProblemText(problem('quota_exceeded'))).toContain('安全请求限额')
    expect(mcpProblemText(problem('invalid_access_token'))).toContain('重新登录')
    expect(mcpProblemText(problem('account:required'))).toContain('重新登录')
    expect(mcpProblemText(problem('call_in_progress'))).toContain('原逻辑调用标识')
    expect(mcpProblemText(problem('idempotency_conflict'))).toContain('不会自动创建新调用收费')
    expect(mcpProblemText(problem('replay_unavailable'))).toContain('不会自动创建新调用收费')
  })

  it('falls back to a generic sentence for unknown codes without leaking internals', () => {
    expect(mcpProblemText(problem('mystery_code'))).toBe(
      '方塘MCP 调用未完成（mystery_code）；已停止自动重试。',
    )
  })
})

describe('readMcpToolProblem', () => {
  it('accepts structured codes, recovers from JSON text, and quarantines unknown codes', () => {
    expect(readMcpToolProblem({ code: 'insufficient_balance' }, '').code).toBe(
      'insufficient_balance',
    )
    expect(readMcpToolProblem('', JSON.stringify({ code: 'dataset_not_allowed' })).code).toBe(
      'dataset_not_allowed',
    )
    expect(readMcpToolProblem({ code: 'not-a-known-code' }, '').code).toBe('mcp_tool_error')
  })

  it('keeps quota dimensions and resetAt only for well-formed values', () => {
    const withDim = readMcpToolProblem(
      {
        code: 'quota_exceeded',
        metadata: { limitDimension: 'day', resetAt: '2026-10-11T00:00:00Z' },
      },
      '',
    )
    expect(withDim.limitDimension).toBe('day')
    expect(withDim.resetAt).toBe('2026-10-11T00:00:00Z')
    expect(
      readMcpToolProblem({ code: 'quota_exceeded', metadata: { limitDimension: 'week' } }, '')
        .limitDimension,
    ).toBeUndefined()
    expect(
      readMcpToolProblem({ code: 'quota_exceeded', metadata: { resetAt: 'not-a-date' } }, '')
        .resetAt,
    ).toBeUndefined()
  })
})

describe('readMcpBillingMetadata', () => {
  it('accepts settled, reserved and released statuses from the trusted side channel', () => {
    for (const status of ['settled', 'reserved', 'released']) {
      const billing = readMcpBillingMetadata(
        meta({ product: 'policy_mcp', status, amountFen: 50 }),
        context,
      )
      expect(billing?.status).toBe(status)
      expect(billing?.amountFen).toBe(50)
    }
  })

  it('carries the optional billing request id for reconciliation', () => {
    const billing = readMcpBillingMetadata(
      meta({ product: 'policy_mcp', status: 'settled', amountFen: 50, billingRequestId: 'br-1' }),
      context,
    )
    expect(billing?.billingRequestId).toBe('br-1')
    expect(
      readMcpBillingMetadata(
        meta({ product: 'policy_mcp', status: 'settled', amountFen: 50 }),
        context,
      )?.billingRequestId,
    ).toBeUndefined()
  })

  it('rejects mismatched run/call identity, unknown products and malformed amounts', () => {
    expect(readMcpBillingMetadata(undefined, context)).toBeUndefined()
    expect(
      readMcpBillingMetadata(meta({ product: 'other', status: 'settled', amountFen: 50 }), context),
    ).toBeUndefined()
    expect(
      readMcpBillingMetadata(meta({ product: 'policy_mcp', status: 'settled', amountFen: 50 }), {
        ...context,
        aiRunId: 'other',
      } as McpCallContext),
    ).toBeUndefined()
    expect(
      readMcpBillingMetadata(
        meta({ product: 'policy_mcp', status: 'pending', amountFen: 50 }),
        context,
      ),
    ).toBeUndefined()
    expect(
      readMcpBillingMetadata(
        meta({ product: 'policy_mcp', status: 'settled', amountFen: -1 }),
        context,
      ),
    ).toBeUndefined()
    expect(
      readMcpBillingMetadata(
        meta({ product: 'policy_mcp', status: 'settled', amountFen: 1.5 }),
        context,
      ),
    ).toBeUndefined()
  })
})

describe('formatMcpResult', () => {
  it('returns the trusted billing side channel next to a successful tool result', () => {
    const result = formatMcpResult(
      {
        content: [{ type: 'text', text: 'ok' }],
        _meta: meta({ product: 'policy_mcp', status: 'settled', amountFen: 50 }),
      },
      context,
    )
    expect(result.text).toBe('ok')
    expect(result.isError).toBe(false)
    expect(result.billing?.status).toBe('settled')
    expect(result.billing?.amountFen).toBe(50)
  })

  it('translates tool errors into problem text and keeps the billing error code', () => {
    const result = formatMcpResult(
      {
        content: [],
        isError: true,
        structuredContent: { code: 'insufficient_balance' },
        _meta: meta({ product: 'policy_mcp', status: 'released', amountFen: 0 }),
      },
      context,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('余额不足')
    expect(result.billing?.error?.code).toBe('insufficient_balance')
    expect(result.billing?.status).toBe('released')
  })

  it('never treats billing metadata as trusted without application context', () => {
    const result = formatMcpResult({
      content: [{ type: 'text', text: 'ok' }],
      _meta: meta({ product: 'policy_mcp', status: 'settled', amountFen: 50 }),
    })
    expect(result.billing).toBeUndefined()
  })
})
