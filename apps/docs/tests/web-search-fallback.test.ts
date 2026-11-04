import { Editor } from '@tiptap/core'
import { describe, expect, it, vi } from 'vitest'
import { executeTool } from '../src/renderer/ai/tools'
import { editorExtensions } from '../src/renderer/editor/extensions'

describe('web search policy fallback', () => {
  it.each(['error', 'duckduckgo'])('continues without verified sources on %s', async (method) => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: { type: 'doc', content: [{ type: 'docParagraph' }] },
    })
    const webSearch = vi.fn().mockResolvedValue({ method, results: [] })
    vi.stubGlobal('desktop', { webSearch })
    try {
      const result = await executeTool(
        editor,
        {
          id: 's',
          name: 'web_search',
          input: { query: 'office help' },
        },
        { bullet: null, ordered: null },
      )
      expect(result.isError).not.toBe(true)
      expect(result.mutated).toBe(false)
      expect(result.output).toContain('search_policies')
      expect(result.output).toContain('Do not answer from model memory')
    } finally {
      editor.destroy()
      vi.unstubAllGlobals()
    }
  })
})
