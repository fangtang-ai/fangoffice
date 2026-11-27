/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiSkills } from '../../../packages/ui/src/ai-skill'
import type { PresetSkillDef } from '@genoffice/agent-core'

let root: Root
let host: HTMLDivElement
const preset: PresetSkillDef = {
  id: 'cloud-only',
  app: 'docs',
  name: '云端技能',
  systemPrompt: 'v1',
}
const load = vi.fn<() => Promise<PresetSkillDef[]>>()
function Panel() {
  const { active, presets, pick } = useAiSkills(
    'docs',
    async () => ({ disabledPresets: [] }),
    () => load(),
  )
  return createElement(
    'div',
    {},
    createElement('span', {}, active?.systemPrompt ?? 'none'),
    ...presets.map((s) =>
      createElement('button', { key: s.id, onClick: () => pick(s.id) }, s.name),
    ),
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  load.mockReset()
  load.mockResolvedValue([preset])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(async () => {
  await act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('cloud skill refresh in the shared picker', () => {
  it('restores cloud-only selections and refreshes the selected playbook on focus', async () => {
    localStorage.setItem('ft-ai-skill-docs', preset.id)
    await act(async () => root.render(createElement(Panel)))
    expect(host.textContent).toContain('v1')
    load.mockResolvedValue([{ ...preset, systemPrompt: 'v2' }])
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(host.textContent).toContain('v2')
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('applies intentional empty catalogs without resurrecting compiled-in skills', async () => {
    load.mockResolvedValue([])
    await act(async () => root.render(createElement(Panel)))
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })
  it('updates within one minute, keeps the last catalog on failure, and stops polling on unmount', async () => {
    await act(async () => root.render(createElement(Panel)))
    load.mockRejectedValue(new Error('offline'))
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(host.textContent).toContain('云端技能')
    await act(() => root.unmount())
    const count = load.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(120_000)
      window.dispatchEvent(new Event('focus'))
    })
    expect(load).toHaveBeenCalledTimes(count)
    root = createRoot(host)
  })
})
