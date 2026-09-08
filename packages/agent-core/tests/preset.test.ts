import { describe, expect, it } from 'vitest'
import { composeSkills } from '../src/skill'
import { createPresetSkill } from '../src/preset'
import { BUILTIN_PRESETS, presetsForApp } from '../src/presets'

describe('presetsForApp', () => {
  it('serves each catalog preset from exactly one app', () => {
    for (const preset of BUILTIN_PRESETS) {
      expect(presetsForApp(preset.app).map((p) => p.id)).toContain(preset.id)
    }
    const total = BUILTIN_PRESETS.length
    const sum = [...new Set(BUILTIN_PRESETS.map((p) => p.app))].reduce(
      (n, app) => n + presetsForApp(app).length,
      0,
    )
    expect(sum).toBe(total)
  })

  it('has no duplicate ids and non-empty playbooks', () => {
    const ids = BUILTIN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of BUILTIN_PRESETS) {
      expect(preset.systemPrompt.length).toBeGreaterThan(40)
      expect(preset.name).toBeTruthy()
      expect(preset.nameEn).toBeTruthy()
    }
  })
})

describe('createPresetSkill', () => {
  it('contributes nothing while inactive and the playbook once active', () => {
    const preset = BUILTIN_PRESETS[0]!
    const active = { current: null as (typeof BUILTIN_PRESETS)[number] | null }
    const skill = createPresetSkill(active)
    expect(skill.systemPrompt).toBe('')
    expect(skill.tools).toEqual([])

    active.current = preset
    expect(skill.systemPrompt).toContain(preset.systemPrompt)
    expect(skill.systemPrompt).toContain(preset.id)
  })

  it('is live through composeSkills: switching presets changes the next turn', () => {
    const [a, b] = BUILTIN_PRESETS
    const active = { current: null as (typeof BUILTIN_PRESETS)[number] | null }
    const composed = composeSkills('app+preset', '', [createPresetSkill(active)])

    active.current = a!
    expect(composed.systemPrompt).toContain(a!.id)
    active.current = b!
    expect(composed.systemPrompt).toContain(b!.id)
    expect(composed.systemPrompt).not.toContain(a!.id)
  })

  it('exposes the hooked MCP tool defs and routes their execution', async () => {
    const preset = BUILTIN_PRESETS.find((p) => p.mcpServers?.length) ?? BUILTIN_PRESETS[0]!
    preset.mcpServers = ['crm']
    const active = { current: preset as (typeof BUILTIN_PRESETS)[number] | null }
    const calls: string[][] = []
    const skill = createPresetSkill(active, {
      getTools: (servers) => {
        calls.push(servers)
        return [{ name: 'mcp__crm__lookup', description: 'lookup', inputSchema: { type: 'object' } }]
      },
      executeTool: (call) => ({ output: `ran ${call.name}`, summary: call.name }),
    })

    expect(skill.tools.map((t) => t.name)).toEqual(['mcp__crm__lookup'])
    expect(calls).toEqual([['crm']])
    const result = await skill.executeTool({ id: 'c1', name: 'mcp__crm__lookup', input: {} })
    expect(result.output).toBe('ran mcp__crm__lookup')

    active.current = null
    expect(skill.tools).toEqual([])
  })
})
