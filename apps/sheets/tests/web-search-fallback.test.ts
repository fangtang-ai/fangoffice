import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSearchSkill } from '../src/renderer/ai/search-skill'

afterEach(() => vi.unstubAllGlobals())

describe('web search policy fallback', () => {
  it.each(['error', 'duckduckgo'])('continues without verified sources on %s', async (method) => {
    vi.stubGlobal('window', {
      desktopApi: { webSearch: vi.fn().mockResolvedValue({ method, results: [] }) },
    })
    const result = await createSearchSkill().executeTool!({
      id: 's',
      name: 'web_search',
      input: { query: 'office help' },
    })
    expect(result.isError).not.toBe(true)
    expect(result.mutated).toBe(false)
    expect(result.output).toContain('search_policies')
    expect(result.output).toContain('Do not retry web_search')
    expect(result.output).toContain('Do not answer from model memory')
  })
})
