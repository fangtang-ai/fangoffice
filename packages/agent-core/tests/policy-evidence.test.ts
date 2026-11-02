import { describe, expect, it, vi } from 'vitest'
import { AgentLoop } from '../src/loop'
import { createMcpPresetHooks, type McpRendererApi } from '../src/mcp-skill'
import { createPresetSkill, type PresetSkillDef } from '../src/preset'
import { composeSkills } from '../src/skill'
import type { AgentStreamRequest, AgentTransport } from '../src/types'

const searchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    includeEvidence: { type: 'boolean', default: false },
  },
}

function setup(result = { text: '{"data":[]}', isError: false }) {
  const callTool = vi.fn().mockResolvedValue(result)
  const api: McpRendererApi = {
    status: async () => [
      {
        name: 'fangtang',
        transport: 'http',
        enabled: true,
        alwaysAvailable: true,
        connected: true,
        toolCount: 2,
      },
    ],
    listTools: async () => [
      { name: 'search_policies', inputSchema: searchSchema },
      { name: 'read_policy', inputSchema: { type: 'object' } },
    ],
    callTool,
  }
  const hooks = createMcpPresetHooks(api)
  return { api, hooks, callTool }
}

describe('政策证据与日期核验', () => {
  it.each([null, { id: 'writing', app: 'docs', name: '公文', systemPrompt: '按材料起草。' }])(
    '无技能或普通写作技能均获得政策核验说明：%j',
    async (preset: PresetSkillDef | null) => {
      const { hooks } = setup()
      const active = { current: preset }
      const skill = composeSkills('docs', '', [createPresetSkill(active, hooks)])
      await skill.prepareTools?.()
      expect(skill.tools.map((tool) => tool.name)).toContain('mcp__fangtang__search_policies')
      expect(skill.systemPrompt).toContain('publishedAt 是文章发布日期，不是事件发生日期')
      expect(skill.systemPrompt).toContain('分别核对同一地区、同一届次大会正文中的开幕与闭幕日期')
      expect(skill.systemPrompt).toContain('预备会议、代表团会议、主席团会议是不同事件')
      expect(skill.systemPrompt).toContain('不能把相关报道的最早日期和最晚日期拼成会期')
      expect(skill.systemPrompt).toContain('未确认闭幕日期时不得补出完整会期')
      expect(skill.systemPrompt).toContain('sourceUrl')
      active.current = null
      expect(skill.systemPrompt).toContain('政策检索与事实核验')
    },
  )

  it('正文默认为开启，保留过滤器、调用身份及显式的仅元数据请求', async () => {
    const { hooks, callTool } = setup()
    await hooks.prepareTools!([])
    const tool = hooks.getTools!([]).find((t) => t.name.endsWith('__search_policies'))!
    expect(tool.inputSchema).toMatchObject({
      properties: { includeEvidence: { type: 'boolean', default: true } },
    })
    expect(searchSchema.properties.includeEvidence.default).toBe(false)
    const input = { query: '某省第十二次党代会 开幕', regions: ['某省'], page: 2, limit: 5 }
    const context = { aiRunId: 'run-1', logicalCallId: 'call-1' }
    await hooks.executeTool!({ id: 'c1', name: tool.name, input }, undefined, context)
    expect(callTool).toHaveBeenLastCalledWith(
      'fangtang',
      'search_policies',
      { ...input, includeEvidence: true },
      context,
    )
    expect(input).not.toHaveProperty('includeEvidence')
    await hooks.executeTool!({
      id: 'c2',
      name: tool.name,
      input: { query: '只列标题', includeEvidence: false },
    })
    expect(callTool).toHaveBeenLastCalledWith('fangtang', 'search_policies', {
      query: '只列标题',
      includeEvidence: false,
    })
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it('保留会前、开幕、闭幕的正文与各自发布日期，逐轮传给模型核验', async () => {
    const documents = [
      {
        documentId: 'preparatory',
        title: '某省第十二次党代会主席团举行第一次会议',
        publishedAt: '2026-10-19T10:55:00Z',
        text: '大会主席团10月19日下午举行第一次会议。',
        sourceUrl: 'https://example.gov.cn/preparatory',
        truncated: false,
      },
      {
        documentId: 'opening',
        title: '某省第十二次党代会隆重开幕',
        publishedAt: '2026-10-21T01:15:00Z',
        text: '10月20日上午，大会隆重开幕。',
        sourceUrl: 'https://example.gov.cn/opening',
        truncated: false,
      },
      {
        documentId: 'closing',
        title: '某省第十二次党代会胜利闭幕',
        publishedAt: '2026-10-24T00:17:00Z',
        text: '10月23日上午，大会胜利闭幕。',
        sourceUrl: 'https://example.gov.cn/closing',
        truncated: false,
      },
    ]
    const { hooks, callTool } = setup({ text: JSON.stringify({ data: documents }), isError: false })
    const requests: AgentStreamRequest[] = []
    const onDone = vi.fn()
    const transport: AgentTransport = {
      stream(request, callbacks) {
        requests.push(structuredClone(request))
        queueMicrotask(() => {
          if (requests.length === 1) {
            callbacks.onToolCall({
              id: 'search-1',
              name: 'mcp__fangtang__search_policies',
              input: { query: '某省第十二次党代会 开幕 闭幕' },
            })
          } else {
            callbacks.onDelta('已收到证据。')
          }
          callbacks.onDone()
        })
        return { cancel() {} }
      },
    }
    const loop = new AgentLoop({
      transport,
      skill: composeSkills('docs', '', [createPresetSkill({ current: null }, hooks)]),
      events: { onDone },
    })
    loop.run('大会什么时候召开？')
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.system).toContain('不能把相关报道的最早日期和最晚日期拼成会期')
    }
    const results = requests[1]!.messages.flatMap((m) => (m.role === 'tool' ? m.results : []))
    expect(results).toHaveLength(1)
    expect(results[0]!.output).toContain('publishedAt 为文章发布日期，不是事件发生日期')
    expect(results[0]!.output).toContain(JSON.stringify({ data: documents }))
    expect(callTool).toHaveBeenCalledOnce()
    expect(callTool.mock.calls[0]![2]).toEqual({
      query: '某省第十二次党代会 开幕 闭幕',
      includeEvidence: true,
    })
  })

  it.each([
    ['search_policies', '{"data":[{"title":"会议报道","publishedAt":"2026-10-19"}]}'],
    ['read_policy', '{"document":{"text":"正文片段","truncated":true}}'],
  ])('缺少正文或被截断时保留结果并提醒证据不足：%s', async (tool, text) => {
    const { hooks } = setup({ text, isError: false })
    await hooks.prepareTools!([])
    const result = await hooks.executeTool!({ id: 'c', name: `mcp__fangtang__${tool}`, input: {} })
    expect(result.output).toContain('当前结果不足以确认日期')
    expect(result.output).toContain(text)
    expect(result.isError).toBe(false)
  })

  it('失败结果不被包装成证据，也不自动补查或重试', async () => {
    const { hooks, callTool } = setup({ text: '余额不足', isError: true })
    await hooks.prepareTools!([])
    const result = await hooks.executeTool!({
      id: 'failed',
      name: 'mcp__fangtang__search_policies',
      input: { query: '会议' },
    })
    expect(result).toMatchObject({ output: '余额不足', isError: true })
    expect(callTool).toHaveBeenCalledOnce()
  })

  it('不向未声明正文开关的搜索或其他 MCP 工具注入参数和政策规则', async () => {
    const { api, callTool } = setup()
    api.listTools = async () => [{ name: 'search', inputSchema: { type: 'object' } }]
    const hooks = createMcpPresetHooks(api)
    await hooks.prepareTools!([])
    expect(hooks.describeTools!(hooks.getTools!([]))).not.toContain('政策检索与事实核验')
    const result = await hooks.executeTool!({
      id: 'generic',
      name: 'mcp__fangtang__search',
      input: { query: '会议' },
    })
    expect(callTool).toHaveBeenLastCalledWith('fangtang', 'search', { query: '会议' })
    expect(result.output).toBe('{"data":[]}')
    api.listTools = async () => [{ name: 'search_policies', inputSchema: { type: 'object' } }]
    const other = createMcpPresetHooks(api)
    await other.prepareTools!([])
    await other.executeTool!({ id: 'no-switch', name: 'mcp__fangtang__search_policies', input: {} })
    expect(callTool).toHaveBeenLastCalledWith('fangtang', 'search_policies', {})
  })
})
