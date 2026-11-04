import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSearchSkill } from '../src/renderer/ai/search-skill'
import { AgentLoop, type AgentMessage, type AgentTransport } from '@genoffice/agent-core'

afterEach(() => vi.unstubAllGlobals())

describe('web search knowledge fallback', () => {
  it('feeds the fallback back to the model and finishes the same request', async () => {
    const webSearch = vi.fn().mockResolvedValue({ method: 'error', results: [] })
    vi.stubGlobal('window', { markdownApi: { webSearch } })
    let turns = 0
    let fallbackMessage: AgentMessage | undefined
    const transport: AgentTransport = {
      stream(request, callbacks) {
        const first = turns++ === 0
        if (!first) fallbackMessage = request.messages.at(-1)
        queueMicrotask(() => {
          if (first)
            callbacks.onToolCall({ id: 's', name: 'web_search', input: { query: 'office help' } })
          else callbacks.onDelta('未联网核实。根据已有知识，可以先检查设置。')
          callbacks.onDone()
        })
        return { cancel() {} }
      },
    }
    const done = new Promise<string>((resolve, reject) => {
      const loop = new AgentLoop({
        transport,
        skill: createSearchSkill(),
        events: { onDone: (result) => resolve(result.text), onError: reject },
      })
      loop.run('How do I check the settings?')
    })
    expect(await done).toContain('未联网核实')
    expect(JSON.stringify(fallbackMessage)).toContain('existing knowledge')
    expect(webSearch).toHaveBeenCalledOnce()
    expect(turns).toBe(2)
  })

  it.each(['error', 'duckduckgo'])('continues without verified sources on %s', async (method) => {
    const webSearch = vi.fn().mockResolvedValue({ method, results: [], error: 'offline' })
    vi.stubGlobal('window', { markdownApi: { webSearch } })
    const result = await createSearchSkill().executeTool!({
      id: 's',
      name: 'web_search',
      input: { query: 'office help' },
    })
    expect(result.isError).not.toBe(true)
    expect(result.mutated).toBe(false)
    expect(result.output).toContain('existing knowledge')
    expect(result.output).toContain('Do not retry web_search')
    expect(result.output).toContain('not verified online')
    expect(webSearch).toHaveBeenCalledOnce()
  })
})
