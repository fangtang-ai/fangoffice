import { describe, expect, it, vi } from 'vitest'
import {
  createMcpPresetHooks,
  mcpToolName,
  parseMcpToolName,
  type McpCallResult,
  type McpRendererApi,
  type McpServerInfo,
  type McpToolInfo,
} from '../src/mcp-skill'
import type { AgentToolDef } from '../src/types'
import { createPresetSkill } from '../src/preset'
import { AgentLoop } from '../src/loop'
import { composeSkills } from '../src/skill'
import type { AgentTransport } from '../src/types'

describe('mcp tool naming', () => {
  it('round-trips server and tool through the prefixed name', () => {
    const name = mcpToolName('crm', 'lookup_account')
    expect(name).toBe('mcp__crm__lookup_account')
    expect(parseMcpToolName(name)).toEqual({ server: 'crm', tool: 'lookup_account' })
  })

  it('rejects non-MCP and malformed names', () => {
    expect(parseMcpToolName('web_search')).toBeNull()
    expect(parseMcpToolName('mcp__noseparator')).toBeNull()
    expect(parseMcpToolName('mcp__a__')).toBeNull()
  })
})

function fakeApi(
  servers: McpServerInfo[],
  tools: Record<string, McpToolInfo[]>,
  calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [],
): McpRendererApi {
  return {
    status: async () => servers,
    listTools: async (server: string) => tools[server] ?? [],
    callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ server, tool, args })
      return { text: `ok:${tool}`, isError: false } satisfies McpCallResult
    },
  }
}

describe('createMcpPresetHooks', () => {
  it('stops immediately while tools are loading and ignores their late completion', async () => {
    let releaseStatus: ((servers: McpServerInfo[]) => void) | undefined
    const api = fakeApi([], {})
    api.status = vi.fn(
      () =>
        new Promise<McpServerInfo[]>((resolve) => {
          releaseStatus = resolve
        }),
    )
    const transport: AgentTransport = { stream: vi.fn(() => ({ cancel: () => {} })) }
    const onDone = vi.fn()
    const loop = new AgentLoop({
      transport,
      skill: composeSkills('managed', '', [
        createPresetSkill({ current: null }, createMcpPresetHooks(api)),
      ]),
      events: { onDone },
    })
    loop.run('Search policies')
    await vi.waitFor(() => expect(api.status).toHaveBeenCalled())
    loop.cancel()
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        text: '',
        cancelled: true,
        turnLimit: false,
      }),
    )
    expect(loop.busy).toBe(false)
    expect(loop.messages).toEqual([])
    releaseStatus?.([])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(transport.stream).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('waits for managed tools before the first model request without a warm-up', async () => {
    let releaseStatus: ((servers: McpServerInfo[]) => void) | undefined
    const pendingStatus = new Promise<McpServerInfo[]>((resolve) => {
      releaseStatus = resolve
    })
    const api = fakeApi([], { policy: [{ name: 'search', inputSchema: { type: 'object' } }] })
    api.status = vi.fn(() => pendingStatus)
    const modelTools: string[][] = []
    const transport: AgentTransport = {
      stream(request, callbacks) {
        modelTools.push(request.tools.map((tool) => tool.name))
        queueMicrotask(() => {
          callbacks.onDelta('Ready')
          callbacks.onDone()
        })
        return { cancel: () => {} }
      },
    }
    const onDone = vi.fn()
    const loop = new AgentLoop({
      transport,
      skill: composeSkills('managed', '', [
        createPresetSkill({ current: null }, createMcpPresetHooks(api)),
      ]),
      events: { onDone },
    })
    loop.run('Search policies')
    await vi.waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(modelTools).toEqual([])
    releaseStatus?.([
      {
        name: 'policy',
        transport: 'http',
        enabled: true,
        alwaysAvailable: true,
        connected: true,
        toolCount: 1,
        billingProduct: 'policy_mcp',
      },
    ])
    await vi.waitFor(() => expect(modelTools).toEqual([['mcp__policy__search']]))
    expect(onDone).toHaveBeenCalledOnce()
  })

  it.each([
    null,
    { id: 'plain', app: 'markdown', name: 'Plain skill', systemPrompt: 'Write clearly.' },
  ])('exposes always-available tools when the preset has no MCP servers: %j', async (preset) => {
    const hooks = createMcpPresetHooks(
      fakeApi(
        [
          {
            name: 'wiki',
            transport: 'http',
            enabled: true,
            alwaysAvailable: true,
            connected: true,
            toolCount: 1,
          },
        ],
        { wiki: [{ name: 'search', inputSchema: { type: 'object' } }] },
      ),
    )
    const skill = createPresetSkill({ current: preset }, hooks)
    await vi.waitFor(() => {
      expect(skill.tools.map((tool) => tool.name)).toEqual(['mcp__wiki__search'])
    })
    await expect(
      skill.executeTool({ id: 'always-call', name: 'mcp__wiki__search', input: {} }),
    ).resolves.toMatchObject({ output: 'ok:search', isError: false })
  })

  it('forwards application-owned run/call context and keeps billing details out of tool output', async () => {
    const context = {
      aiRunId: 'f4245812-731b-43e0-a1b4-ef2810140b05',
      logicalCallId: '49520531-9c09-4915-8c40-7599c4385753',
    }
    const billing = {
      ...context,
      product: 'policy_mcp' as const,
      status: 'settled' as const,
      amountFen: 50,
    }
    const api = fakeApi([], {})
    const callTool = vi.fn().mockResolvedValue({ text: 'business-result', isError: false, billing })
    api.callTool = callTool
    const hooks = createMcpPresetHooks(api)
    const execution = await hooks.executeTool!(
      { id: 'model-controlled-id', name: 'mcp__policy__search', input: {} },
      undefined,
      context,
    )
    expect(callTool).toHaveBeenCalledWith('policy', 'search', {}, context)
    expect(execution.billing).toEqual(billing)
    expect(execution.output).toBe('business-result')
    expect(execution.output).not.toContain(context.aiRunId)
  })

  it('merges always-available servers with the preset servers into tool defs', async () => {
    const hooks = createMcpPresetHooks(
      fakeApi(
        [
          {
            name: 'wiki',
            transport: 'http',
            enabled: true,
            alwaysAvailable: true,
            connected: false,
            toolCount: 0,
          },
        ],
        {
          wiki: [
            { name: 'search', description: 'Search the wiki', inputSchema: { type: 'object' } },
          ],
          crm: [{ name: 'lookup', inputSchema: { type: 'object' } }],
        },
      ),
    )
    const tools: AgentToolDef[] = hooks.getTools!([])
    // first call returns the (empty) snapshot and kicks off the refresh
    expect(tools).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    const settled = hooks.getTools!([])
    expect(settled.map((t) => t.name)).toEqual(['mcp__wiki__search'])

    await new Promise((r) => setTimeout(r, 0))
    const withPreset = hooks.getTools!(['crm'])
    await new Promise((r) => setTimeout(r, 0))
    expect(
      hooks.getTools!(['crm'])
        .map((t) => t.name)
        .sort(),
    ).toEqual(['mcp__crm__lookup', 'mcp__wiki__search'])
    void withPreset
  })

  it('routes executeTool over the API and reports errors as results', async () => {
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = []
    const hooks = createMcpPresetHooks(fakeApi([], { crm: [] }, calls))
    const result = await hooks.executeTool!({ id: 'c', name: 'mcp__crm__lookup', input: { id: 7 } })
    expect(result).toMatchObject({ output: 'ok:lookup', isError: false, summary: 'crm:lookup' })
    expect(calls).toEqual([{ server: 'crm', tool: 'lookup', args: { id: 7 } }])

    const failApi = fakeApi([], {}, [])
    failApi.callTool = async (): Promise<McpCallResult> => ({ text: 'boom', isError: true })
    const failing = createMcpPresetHooks(failApi)
    const bad = await failing.executeTool!({ id: 'c', name: 'mcp__crm__boom', input: {} })
    expect(bad).toMatchObject({ isError: true })

    const unknown = await hooks.executeTool!({ id: 'c', name: 'web_search', input: {} })
    expect(unknown.isError).toBe(true)
  })

  it('describeTools renders a prompt section only when tools exist', () => {
    const hooks = createMcpPresetHooks(fakeApi([], {}, []))
    const empty = hooks.describeTools!([])
    expect(empty).toBe('')
    const section = hooks.describeTools!([
      {
        name: 'mcp__crm__lookup',
        description: '[crm MCP] lookup',
        inputSchema: { type: 'object' },
      },
    ])
    expect(section).toContain('MCP')
    expect(section).toContain('mcp__crm__lookup')
  })
})

const RUN_A = 'f4245812-731b-43e0-a1b4-ef2810140b05'
const RUN_B = '49520531-9c09-4915-8c40-7599c4385753'
const ctxOf = (aiRunId: string, n: number) => ({
  aiRunId,
  logicalCallId: `${aiRunId.slice(0, 8)}-0000-4000-8000-00000000000${n}`,
})

function paidApi(
  calls: Array<{ server: string; tool: string }> = [],
  result?: Partial<McpCallResult>,
): McpRendererApi {
  return {
    status: async () => [
      {
        name: 'policy',
        transport: 'http',
        enabled: true,
        alwaysAvailable: false,
        connected: true,
        toolCount: 1,
        billingProduct: 'policy_mcp',
      },
      {
        name: 'wiki',
        transport: 'http',
        enabled: true,
        alwaysAvailable: false,
        connected: true,
        toolCount: 1,
      },
    ],
    listTools: async () => [{ name: 'search', inputSchema: { type: 'object' } }],
    // guardrail tests below focus on the 10-call limit; disclosure consent is the default
    onPaidCallDisclosure: async () => true,
    callTool: async (server, tool) => {
      calls.push({ server, tool })
      return { text: `ok:${tool}`, isError: false, ...result }
    },
  }
}

describe('paid-call guardrail', () => {
  it('counts each paid managed call and blocks the run beyond the budget', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const hooks = createMcpPresetHooks(paidApi(calls), { maxPaidMcpCallsPerRun: 2 })
    for (let i = 0; i < 2; i++) {
      const ok = await hooks.executeTool!(
        { id: `c${i}`, name: 'mcp__policy__search', input: {} },
        undefined,
        ctxOf(RUN_A, i),
      )
      expect(ok.isError).toBe(false)
    }
    const blocked = await hooks.executeTool!(
      { id: 'c3', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 3),
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toMatch(/budget/i)
    expect(calls).toHaveLength(2)
    expect(blocked.billing).toBeUndefined()
  })

  it('discloses the price once before the first paid call of a run', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const onPaidCallDisclosure = vi.fn().mockResolvedValue(true)
    const api = paidApi(calls)
    api.onPaidCallDisclosure = onPaidCallDisclosure
    const hooks = createMcpPresetHooks(api)
    for (let i = 0; i < 2; i++) {
      const ok = await hooks.executeTool!(
        { id: `c${i}`, name: 'mcp__policy__search', input: {} },
        undefined,
        ctxOf(RUN_A, i),
      )
      expect(ok.isError).toBe(false)
    }
    expect(onPaidCallDisclosure).toHaveBeenCalledTimes(1)
    expect(onPaidCallDisclosure).toHaveBeenCalledWith({ aiRunId: RUN_A })
    expect(calls).toHaveLength(2)
  })

  it('declining the disclosure blocks the run without spending a paid call', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const onPaidCallDisclosure = vi.fn().mockResolvedValue(false)
    const onPaidCallLimit = vi.fn().mockResolvedValue(true)
    const api = paidApi(calls)
    api.onPaidCallDisclosure = onPaidCallDisclosure
    api.onPaidCallLimit = onPaidCallLimit
    const hooks = createMcpPresetHooks(api)
    const first = await hooks.executeTool!(
      { id: 'c0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 0),
    )
    expect(first.isError).toBe(true)
    expect(first.output).toMatch(/declined/i)
    expect(calls).toHaveLength(0)
    // refusing must not consume the budget, and the run stays declined
    const second = await hooks.executeTool!(
      { id: 'c1', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 1),
    )
    expect(second.isError).toBe(true)
    expect(onPaidCallDisclosure).toHaveBeenCalledTimes(1)
    expect(onPaidCallLimit).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('blocks paid calls when no disclosure callback is available', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const api = paidApi(calls)
    delete (api as Partial<McpRendererApi>).onPaidCallDisclosure
    const hooks = createMcpPresetHooks(api)
    const blocked = await hooks.executeTool!(
      { id: 'c0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 0),
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toMatch(/disclosure|declined/i)
    expect(calls).toHaveLength(0)
    expect(blocked.billing).toBeUndefined()
  })

  it('raises the allowance when the user confirms the pause', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const onPaidCallLimit = vi.fn().mockResolvedValue(true)
    const api = paidApi(calls)
    api.onPaidCallLimit = onPaidCallLimit
    const hooks = createMcpPresetHooks(api, { maxPaidMcpCallsPerRun: 1 })
    const first = await hooks.executeTool!(
      { id: 'c0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 0),
    )
    expect(first.isError).toBe(false)
    expect(onPaidCallLimit).not.toHaveBeenCalled()
    const second = await hooks.executeTool!(
      { id: 'c1', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 1),
    )
    expect(second.isError).toBe(false)
    expect(onPaidCallLimit).toHaveBeenCalledWith({ aiRunId: RUN_A, used: 1, max: 1 })
    expect(calls).toHaveLength(2)
    expect(onPaidCallLimit).toHaveBeenCalledTimes(1)
  })

  it('declining stops the paid call before it reaches the tool', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const onPaidCallLimit = vi.fn().mockResolvedValue(false)
    const api = paidApi(calls)
    api.onPaidCallLimit = onPaidCallLimit
    const hooks = createMcpPresetHooks(api, { maxPaidMcpCallsPerRun: 0 })
    const blocked = await hooks.executeTool!(
      { id: 'c0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 0),
    )
    expect(blocked.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('failed paid calls still consume the budget', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const hooks = createMcpPresetHooks(paidApi(calls, { isError: true }), {
      maxPaidMcpCallsPerRun: 1,
    })
    const bad = await hooks.executeTool!(
      { id: 'c0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 0),
    )
    expect(bad.isError).toBe(true)
    const blocked = await hooks.executeTool!(
      { id: 'c1', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 1),
    )
    expect(blocked.isError).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('free third-party servers bypass the gate', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const onPaidCallLimit = vi.fn().mockResolvedValue(false)
    const api = paidApi(calls)
    api.onPaidCallLimit = onPaidCallLimit
    const hooks = createMcpPresetHooks(api, { maxPaidMcpCallsPerRun: 0 })
    for (let i = 0; i < 3; i++) {
      const ok = await hooks.executeTool!(
        { id: `c${i}`, name: 'mcp__wiki__search', input: {} },
        undefined,
        ctxOf(RUN_A, i),
      )
      expect(ok.isError).toBe(false)
    }
    expect(onPaidCallLimit).not.toHaveBeenCalled()
    expect(calls).toHaveLength(3)
  })

  it('unmanaged requests without context never hit the gate', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const hooks = createMcpPresetHooks(paidApi(calls), { maxPaidMcpCallsPerRun: 0 })
    const ok = await hooks.executeTool!({ id: 'c0', name: 'mcp__policy__search', input: {} })
    expect(ok.isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('a new run id starts with a fresh budget', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const hooks = createMcpPresetHooks(paidApi(calls), { maxPaidMcpCallsPerRun: 1 })
    await hooks.executeTool!(
      { id: 'a0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 0),
    )
    const blocked = await hooks.executeTool!(
      { id: 'a1', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 1),
    )
    expect(blocked.isError).toBe(true)
    const fresh = await hooks.executeTool!(
      { id: 'b0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_B, 0),
    )
    expect(fresh.isError).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('a declined pause does not consume the budget', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const onPaidCallLimit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const api = paidApi(calls)
    api.onPaidCallLimit = onPaidCallLimit
    const hooks = createMcpPresetHooks(api, { maxPaidMcpCallsPerRun: 1 })
    const first = await hooks.executeTool!(
      { id: 'c0', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 0),
    )
    expect(first.isError).toBe(false)
    const declined = await hooks.executeTool!(
      { id: 'c1', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 1),
    )
    expect(declined.isError).toBe(true)
    expect(calls).toHaveLength(1)
    const allowed = await hooks.executeTool!(
      { id: 'c2', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 2),
    )
    expect(allowed.isError).toBe(false)
    expect(calls).toHaveLength(2)
    // the declined call left used at 1: the second pause still reports one used call
    expect(onPaidCallLimit).toHaveBeenNthCalledWith(2, { aiRunId: RUN_A, used: 1, max: 1 })
  })

  it('does not spend a paid call when the run is cancelled while waiting on the gate', async () => {
    const calls: Array<{ server: string; tool: string }> = []
    const controller = new AbortController()
    const onPaidCallLimit = vi.fn().mockImplementation(async () => {
      controller.abort()
      return true
    })
    const api = paidApi(calls)
    api.onPaidCallLimit = onPaidCallLimit
    const hooks = createMcpPresetHooks(api, { maxPaidMcpCallsPerRun: 0 })
    const stopped = await hooks.executeTool!(
      { id: 'c0', name: 'mcp__policy__search', input: {} },
      controller.signal,
      ctxOf(RUN_A, 0),
    )
    expect(stopped.isError).toBe(true)
    expect(calls).toHaveLength(0)
    // nothing was consumed: the next confirmed call goes through
    const ok = await hooks.executeTool!(
      { id: 'c1', name: 'mcp__policy__search', input: {} },
      undefined,
      ctxOf(RUN_A, 1),
    )
    expect(ok.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(onPaidCallLimit).toHaveBeenCalledTimes(2)
  })

  it('retries status after a failed rebuild and recovers tool visibility', async () => {
    let failing = true
    const api = paidApi([])
    api.status = async () => {
      if (failing) throw new Error('hub busy')
      return [
        {
          name: 'wiki',
          transport: 'http',
          enabled: true,
          alwaysAvailable: true,
          connected: true,
          toolCount: 1,
        },
      ]
    }
    const hooks = createMcpPresetHooks(api)
    expect(hooks.getTools!([])).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    expect(hooks.getTools!([])).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    failing = false
    expect(hooks.getTools!([])).toEqual([])
    await new Promise((r) => setTimeout(r, 0))
    expect(hooks.getTools!([]).map((t) => t.name)).toEqual(['mcp__wiki__search'])
  })
})
