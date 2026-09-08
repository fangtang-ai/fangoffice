import type { AgentSkill } from './skill'
import type { AgentToolCall, AgentToolDef, ToolExecution } from './types'

/**
 * A built-in generation skill (技能): a curated prompt playbook the user can
 * select in the AI chat window while producing a document. Definitions are
 * data (see presets.ts) so the settings pane and the chat picker share one
 * catalog; selection is runtime state, not a setting.
 */
export interface PresetSkillDef {
  id: string
  /** which editor app offers the preset ('docs' | 'sheets' | 'slides' | 'pdf' | 'markdown') */
  app: string
  /** display name, zh first (the primary deployment locale) */
  name: string
  /** display name, en (optional: file-loaded presets may omit it) */
  nameEn?: string
  description?: string
  descriptionEn?: string
  /** the playbook: injected as a system-prompt section while active */
  systemPrompt: string
  /**
   * Built-in MCP server names (fangtang-mcp.json keys) this preset may call.
   * While the preset is active, those servers' tools join the conversation.
   */
  mcpServers?: string[]
}

/** Runtime selection holder — panels mutate `current`, the skill reads it live. */
export interface ActivePreset {
  current: PresetSkillDef | null
}

export interface PresetSkillHooks {
  /**
   * Tool defs offered for the active preset's MCP servers (cached upstream).
   * Called before every model turn; return [] when no server answers.
   */
  getTools?(servers: string[]): AgentToolDef[]
  /** Executor for the tools produced by getTools (routed by tool name). */
  executeTool?(call: AgentToolCall, signal?: AbortSignal): ToolExecution | Promise<ToolExecution>
  /**
   * Prompt section describing the current MCP tools (appended after the
   * playbook so the model knows when to reach for them).
   */
  describeTools?(tools: AgentToolDef[]): string
}

/**
 * The live skill backing the chat window's preset picker. `systemPrompt` and
 * `tools` are getters on purpose: composeSkills re-reads them before every
 * model request, so switching the preset takes effect on the next message
 * without rebuilding the loop.
 */
export function createPresetSkill(active: ActivePreset, hooks?: PresetSkillHooks): AgentSkill {
  return {
    id: 'preset',
    get systemPrompt() {
      const preset = active.current
      if (!preset) return ''
      let prompt =
        `\n\n# Active skill: ${preset.name} (${preset.id})\n` +
        'The user selected this skill for the current request — follow its playbook precisely.\n' +
        preset.systemPrompt
      if (hooks?.getTools && hooks.describeTools) {
        const description = hooks.describeTools(hooks.getTools(preset.mcpServers ?? []))
        if (description) prompt += description
      }
      return prompt
    },
    get tools() {
      const preset = active.current
      if (!preset?.mcpServers?.length || !hooks?.getTools) return []
      return hooks.getTools(preset.mcpServers)
    },
    executeTool: (call, signal) => {
      if (hooks?.executeTool) return hooks.executeTool(call, signal)
      return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
    },
  }
}
