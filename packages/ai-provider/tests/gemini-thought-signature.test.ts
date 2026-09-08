import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@genoffice/agent-core'
import { geminiContents } from '../src/protocols/gemini'

describe('geminiContents thought-signature echo', () => {
  it('echoes the signature on functionCall parts (Gemini 3 400s without it)', () => {
    const messages: AgentMessage[] = [
      { role: 'user', text: 'search the web for it' },
      {
        role: 'assistant',
        text: 'Let me search that for you.',
        thoughtSignature: 'sig-text-abc',
        toolCalls: [
          { id: 'c1', name: 'web_search', input: { query: 'x' }, thoughtSignature: 'sig-fn-123' },
        ],
      },
      {
        role: 'tool',
        results: [{ id: 'c1', name: 'web_search', output: 'results…' }],
      },
    ]
    const contents = geminiContents(messages) as Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }>
    const modelTurn = contents[1]!
    expect(modelTurn.role).toBe('model')
    // the functionCall part carries its signature back
    expect(modelTurn.parts[1]).toEqual({
      functionCall: { name: 'web_search', args: { query: 'x' } },
      thoughtSignature: 'sig-fn-123',
    })
    // the text part carries the turn signature too
    expect(modelTurn.parts[0]).toEqual({
      text: 'Let me search that for you.',
      thoughtSignature: 'sig-text-abc',
    })
  })

  it('omits signature fields when the provider did not send any', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        text: 'done',
        toolCalls: [{ id: 'c1', name: 'read_blocks', input: {} }],
      },
    ]
    const contents = geminiContents(messages) as Array<{ parts: Array<Record<string, unknown>> }>
    expect(contents[0]!.parts[0]).toEqual({ text: 'done' })
    expect(contents[0]!.parts[1]).toEqual({ functionCall: { name: 'read_blocks', args: {} } })
  })
})
