import { describe, expect, it, vi } from 'vitest'
import { AgentLoop } from '../src/loop'
import { createMcpPresetHooks, type McpRendererApi } from '../src/mcp-skill'
import { createPresetSkill } from '../src/preset'
import { composeSkills, type AgentSkill } from '../src/skill'
import type { AgentStreamRequest, AgentTransport, ToolExecution } from '../src/types'
import { webSearchPolicyFallback, withPolicySearchFallback } from '../src/web-search'

const searchName = 'mcp__office__search_policies'
const readName = 'mcp__office__read_policy'
const sourceUrl = 'https://www.example.gov.cn/policy/1'
const original = {
  documentId: 'policy-1',
  title: '测试政策',
  text: '申报截止时间为11月30日。',
  sourceUrl,
}

function setup(
  options: { enabled?: boolean; disclosure?: boolean; error?: string; empty?: boolean } = {},
) {
  const webSearch = vi.fn(async () => webSearchPolicyFallback('Web search'))
  const api: McpRendererApi = {
    status: async () => [
      {
        name: 'office',
        transport: 'http',
        enabled: options.enabled !== false,
        alwaysAvailable: true,
        connected: true,
        toolCount: 2,
        billingProduct: 'policy_mcp',
      },
    ],
    listTools: async () => [
      {
        name: 'search_policies',
        inputSchema: { type: 'object', properties: { includeEvidence: { type: 'boolean' } } },
      },
      { name: 'read_policy', inputSchema: { type: 'object' } },
    ],
    callTool: vi.fn(async (_server, tool) =>
      options.error
        ? { text: JSON.stringify({ code: options.error }), isError: true }
        : {
            text: JSON.stringify(
              tool === 'read_policy'
                ? { document: original }
                : { data: options.empty ? [] : [{ ...original, text: '申报…', truncated: true }] },
            ),
            isError: false,
          },
    ),
    onPaidCallDisclosure: vi.fn(async () => options.disclosure !== false),
  }
  const local: AgentSkill = {
    id: 'search',
    systemPrompt: 'Use web_search for current facts.',
    tools: ['web_search', 'search_knowledge', 'read_knowledge_source', 'apply_ops'].map((name) => ({
      name,
      description: name,
      inputSchema: {},
    })),
    executeTool: webSearch,
  }
  const skill = withPolicySearchFallback(
    composeSkills('editor', '', [
      local,
      createPresetSkill({ current: null }, createMcpPresetHooks(api)),
    ]),
  )
  return { skill, api, webSearch }
}

async function runScenario(options: Parameters<typeof setup>[0] = {}) {
  const fixture = setup(options)
  const requests: AgentStreamRequest[] = []
  const executions: ToolExecution[] = []
  const transport: AgentTransport = {
    stream(request, callbacks) {
      requests.push(request)
      queueMicrotask(() => {
        const turn = requests.length
        if (turn === 1)
          callbacks.onToolCall({ id: 'web', name: 'web_search', input: { query: '申报截止日期' } })
        else if (turn === 2 && request.tools.some((tool) => tool.name === searchName))
          callbacks.onToolCall({ id: 'search', name: searchName, input: { query: '申报截止日期' } })
        else if (turn === 3 && !options.error && !options.empty && options.disclosure !== false)
          callbacks.onToolCall({ id: 'read', name: readName, input: { documentId: 'policy-1' } })
        else
          callbacks.onDelta(
            turn === 4
              ? `依据[测试政策](${sourceUrl})，截止日期为11月30日。`
              : '未取得可用的政策原文，无法据此回答，请提供相关政策。',
          )
        callbacks.onDone()
      })
      return { cancel() {} }
    },
  }
  const text = await new Promise<string>((resolve, reject) => {
    const loop = new AgentLoop({
      skill: fixture.skill,
      transport,
      events: {
        onDone: (result) => resolve(result.text),
        onError: reject,
        onToolExecuted: ({ execution }) => executions.push(execution),
      },
    })
    loop.run('请查申报截止日期')
  })
  return { ...fixture, requests, executions, text }
}

describe('web search to policy MCP fallback', () => {
  it('continues through paid policy search and original-text reading, preserving call identity', async () => {
    const { requests, api, text, webSearch } = await runScenario()
    expect(webSearch).toHaveBeenCalledOnce()
    expect(api.callTool).toHaveBeenCalledTimes(2)
    expect(api.onPaidCallDisclosure).toHaveBeenCalledOnce()
    expect(requests[1]!.system).toContain('Do not answer from model memory')
    expect(requests[1]!.tools.map((tool) => tool.name)).not.toContain('web_search')
    expect(requests[1]!.tools.map((tool) => tool.name)).not.toContain('search_knowledge')
    expect(JSON.stringify(requests[3]!.messages)).toContain(original.text)
    expect(text).toContain(sourceUrl)
    const calls = vi.mocked(api.callTool).mock.calls
    expect(calls[0]![2]).toEqual({ query: '申报截止日期', includeEvidence: true })
    expect(calls[1]![2]).toEqual({ documentId: 'policy-1' })
    expect(calls[0]![3]!.aiRunId).toBe(calls[1]![3]!.aiRunId)
    expect(calls[0]![3]!.logicalCallId).not.toBe(calls[1]![3]!.logicalCallId)
  })

  it.each(['ACCESS_DENIED', 'INSUFFICIENT_BALANCE', 'UPSTREAM_UNAVAILABLE'])(
    'stops policy calls after %s without switching back to memory',
    async (error) => {
      const { api, text, requests, executions } = await runScenario({ error })
      expect(api.callTool).toHaveBeenCalledOnce()
      expect(requests.at(-1)!.tools.map((tool) => tool.name)).not.toContain(readName)
      expect(executions.at(-1)!.output).toContain(error)
      expect(executions.at(-1)!.output).toContain('Do not answer from model memory')
      expect(text).toContain('未取得可用的政策原文')
    },
  )

  it('does not call or silently enable a disabled policy service', async () => {
    const { api, text } = await runScenario({ enabled: false })
    expect(api.callTool).not.toHaveBeenCalled()
    expect(text).toContain('未取得可用的政策原文')
  })

  it('preserves first-use payment decline without calling the server', async () => {
    const { api, text, executions } = await runScenario({ disclosure: false })
    expect(api.onPaidCallDisclosure).toHaveBeenCalledOnce()
    expect(api.callTool).not.toHaveBeenCalled()
    expect(executions.at(-1)!.output).toContain('declined')
    expect(text).toContain('未取得可用的政策原文')
  })

  it('does not read an invented ID after an empty search', async () => {
    const { api, text } = await runScenario({ empty: true })
    expect(api.callTool).toHaveBeenCalledOnce()
    expect(text).toContain('未取得可用的政策原文')
  })

  it('resets fallback on the next user run and blocks stale web calls', async () => {
    const { skill, webSearch } = setup()
    await skill.prepareTools?.()
    await skill.executeTool({ id: 'w1', name: 'web_search', input: {} })
    expect((await skill.executeTool({ id: 'w2', name: 'web_search', input: {} })).isError).toBe(
      true,
    )
    expect(webSearch).toHaveBeenCalledOnce()
    await skill.prepareTools?.()
    expect(skill.tools.map((tool) => tool.name)).toContain('web_search')
    expect(skill.systemPrompt).not.toContain('Do not answer from model memory')
  })

  it('handles rejected search IPC and preserves normal success, context, and verification', async () => {
    const verifyResponse = vi.fn(() => 'existing verification')
    const executeTool = vi
      .fn<AgentSkill['executeTool']>()
      .mockRejectedValueOnce(new Error('IPC offline'))
      .mockResolvedValueOnce({ output: 'real web source', summary: 'Search' })
    const skill = withPolicySearchFallback({
      id: 's',
      tools: [],
      systemPrompt: '',
      executeTool,
      verifyResponse,
    })
    await skill.prepareTools?.()
    expect(
      (await skill.executeTool({ id: 'a', name: 'web_search', input: {} })).policyFallbackRequired,
    ).toBe(true)
    await skill.prepareTools?.()
    const context = { aiRunId: 'run', logicalCallId: 'call' }
    const result = await skill.executeTool(
      { id: 'b', name: 'web_search', input: {} },
      undefined,
      context,
    )
    expect(result.output).toBe('real web source')
    expect(result.policyFallbackRequired).toBeUndefined()
    expect(executeTool.mock.calls[1]![2]).toBe(context)
    expect(skill.verifyResponse?.('answer', [])).toBe('existing verification')
  })
})
