export interface AccountMcpBinding {
  userId: string
  sessionId: number
  signal: AbortSignal
}

export interface AccountMcpAccess {
  apiBase(): string | null
  bind(): AccountMcpBinding
  isCurrent(binding: AccountMcpBinding): boolean
  token(binding: AccountMcpBinding, rejectedToken?: string): Promise<string>
  subscribe?(listener: () => void): () => void
  allowLoopback?: boolean
}

export class AccountMcpError extends Error {
  constructor(
    readonly code:
      | 'account:required'
      | 'account:mcp-disabled'
      | 'account:changed'
      | 'account:untrusted-target'
      | 'account:request-failed',
    readonly problem?: OfficeBillingProblem,
  ) {
    super(code)
  }
}

export function resolveAccountMcpUrl(configured: string, access: AccountMcpAccess) {
  try {
    const base = new URL(access.apiBase() ?? '')
    const loopback =
      access.allowLoopback === true && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw new Error()
    if (base.username || base.password || base.search || base.hash) throw new Error()
    const expected = new URL('/api/office/mcp', base)
    const requested =
      configured === '${ACCOUNT_API_BASE}/api/office/mcp' ? expected : new URL(configured)
    if (requested.href !== expected.href) throw new Error()
    return expected
  } catch {
    throw new AccountMcpError('account:untrusted-target')
  }
}

export function assertAccountMcpBinding(access: AccountMcpAccess, binding: AccountMcpBinding) {
  if (binding.signal.aborted || !access.isCurrent(binding))
    throw new AccountMcpError('account:changed')
}

export function createAccountMcpFetch(
  endpoint: URL,
  access: AccountMcpAccess,
  binding: AccountMcpBinding,
) {
  return async (input: string | URL, init?: RequestInit) => {
    try {
      const first = await sendAccountMcpRequest(endpoint, input, init, access, binding)
      if (first.response.status !== 401)
        return await checkedAccountResponse(first.response, access, binding)
      await first.response.body?.cancel()
      // 只重传一次原请求；刷新绑定旧账号，绝不切换 token 到新账号。
      const retry = await sendAccountMcpRequest(endpoint, input, init, access, binding, first.token)
      if (retry.response.status === 401) {
        await retry.response.body?.cancel()
        throw new AccountMcpError('account:required')
      }
      return await checkedAccountResponse(retry.response, access, binding)
    } catch (error) {
      assertAccountMcpBinding(access, binding)
      if (error instanceof AccountMcpError) throw error
      // 网络/服务端异常可能包含请求头或 URL；受管错误只输出固定类别。
      throw new AccountMcpError('account:request-failed')
    }
  }
}

async function checkedAccountResponse(
  response: Response,
  access: AccountMcpAccess,
  binding: AccountMcpBinding,
) {
  if (response.ok) return response
  const text = await response.text()
  assertAccountMcpBinding(access, binding)
  throw new AccountMcpError('account:request-failed', readMcpToolProblem(undefined, text))
}

async function readAccountMcpToken(
  access: AccountMcpAccess,
  binding: AccountMcpBinding,
  rejectedToken?: string,
) {
  try {
    const token = await access.token(binding, rejectedToken)
    assertAccountMcpBinding(access, binding)
    if (!token.trim()) throw new AccountMcpError('account:required')
    return token
  } catch {
    assertAccountMcpBinding(access, binding)
    throw new AccountMcpError('account:required')
  }
}

async function sendAccountMcpRequest(
  endpoint: URL,
  input: string | URL,
  init: RequestInit | undefined,
  access: AccountMcpAccess,
  binding: AccountMcpBinding,
  rejectedToken?: string,
) {
  if (
    new URL(input).href !== endpoint.href ||
    resolveAccountMcpUrl(endpoint.href, access).href !== endpoint.href
  ) {
    throw new AccountMcpError('account:untrusted-target')
  }
  assertAccountMcpBinding(access, binding)
  const token = await readAccountMcpToken(access, binding, rejectedToken)
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.delete('Cookie')
  headers.delete('Proxy-Authorization')
  const signal = init?.signal ? AbortSignal.any([init.signal, binding.signal]) : binding.signal
  const response = await globalThis.fetch(endpoint, {
    ...init,
    headers,
    signal,
    credentials: 'omit',
    redirect: 'error',
  })
  assertAccountMcpBinding(access, binding)
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    (response.url && response.url !== endpoint.href)
  ) {
    await response.body?.cancel()
    throw new AccountMcpError('account:untrusted-target')
  }
  return { response, token }
}
import type { OfficeBillingProblem } from '@genoffice/agent-core'
import { readMcpToolProblem } from './billing-result'
