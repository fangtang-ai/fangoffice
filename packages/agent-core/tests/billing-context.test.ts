import { expect, it, vi } from 'vitest'
import { AgentLoop, composeSkills, type AgentSkill, type AgentTransport } from '../src'

it('creates one application run UUID per task and distinct logical UUIDs through composed skills', async () => {
  let turns = 0
  const stream = vi.fn<AgentTransport['stream']>((_request, callbacks) => {
    const withTools = turns++ % 2 === 0
    queueMicrotask(() => {
      if (withTools) {
        callbacks.onToolCall({
          id: 'model-id',
          name: 'lookup',
          input: { aiRunId: 'model-selected' },
        })
        callbacks.onToolCall({ id: 'model-id', name: 'lookup', input: {} })
      } else callbacks.onDelta('done')
      callbacks.onDone()
    })
    return { cancel: () => {} }
  })
  const execute = vi.fn<AgentSkill['executeTool']>(() => ({
    output: 'business',
    summary: 'lookup',
  }))
  const skill = composeSkills('composed', '', [
    {
      id: 'lookup',
      systemPrompt: '',
      tools: [{ name: 'lookup', description: '', inputSchema: {} }],
      executeTool: execute,
    },
  ])
  const onDone = vi.fn()
  const onRunStart = vi.fn()
  const loop = new AgentLoop({ transport: { stream }, skill, events: { onDone, onRunStart } })
  loop.run('task one')
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  const firstRun = stream.mock.calls[0]![0].aiRunId
  expect(firstRun).toMatch(/^[\da-f]{8}-[\da-f-]{27}$/i)
  expect(stream.mock.calls[1]![0].aiRunId).toBe(firstRun)
  const contexts = execute.mock.calls.map((call) => call[2])
  expect(contexts[0]?.aiRunId).toBe(firstRun)
  expect(contexts[1]?.aiRunId).toBe(firstRun)
  expect(contexts[0]?.logicalCallId).not.toBe(contexts[1]?.logicalCallId)
  expect(contexts[0]?.logicalCallId).not.toBe('model-id')
  expect(onRunStart).toHaveBeenCalledWith(firstRun)
  expect(JSON.stringify(loop.messages)).not.toContain(firstRun)
  loop.run('task two')
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(2))
  expect(stream.mock.calls[2]![0].aiRunId).not.toBe(firstRun)
})
