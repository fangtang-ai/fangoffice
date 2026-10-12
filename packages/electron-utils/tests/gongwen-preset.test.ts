import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPresetFiles, parsePresetMarkdown } from '../src/preset-files'

const bundledDirectory = fileURLToPath(
  new URL('../../../apps/shell/resources/presets/', import.meta.url),
)
const authoringFile = new URL('../../../presets/docs/方塘AI公文写作.md', import.meta.url)

function loadGongwenPreset() {
  const preset = loadPresetFiles(bundledDirectory).find(
    (entry) => entry.id === 'docs-fangtang-gongwen',
  )
  if (!preset) throw new Error('Bundled official-document preset is missing')
  return preset
}

describe('bundled official-document writing preset', () => {
  it('loads a general-purpose playbook under the existing skill identity', async () => {
    const preset = loadGongwenPreset()

    expect(preset).toMatchObject({
      app: 'docs',
      id: 'docs-fangtang-gongwen',
      name: '方塘公文写作',
    })
    expect(preset.systemPrompt.includes('2025年')).toBe(false)
    expect(/默认[^\n]*(?:河南省|办公厅)/.test(preset.systemPrompt)).toBe(false)
    expect(preset.systemPrompt.includes('AI知识库摘要')).toBe(false)
    expect(preset.systemPrompt.includes('1+2+4+N')).toBe(false)

    const authoring = parsePresetMarkdown(
      'docs',
      '方塘AI公文写作.md',
      await readFile(authoringFile, 'utf8'),
    )
    expect(authoring).toEqual(preset)
  })

  it('ships distinct genres with explicit request and report boundaries', () => {
    const { systemPrompt } = loadGongwenPreset()

    for (const genre of ['通知', '请示', '报告', '函与复函', '批复', '纪要', '方案与计划']) {
      expect(systemPrompt.includes(genre), genre).toBe(true)
    }
    expect(systemPrompt.includes('在情况报告中夹带请求批准事项')).toBe(true)
    expect(systemPrompt.includes('把申请写成既成决定')).toBe(true)
    expect(systemPrompt.includes('把个人意见、讨论方案写成会议决定')).toBe(true)
  })

  it('separates user facts, policy evidence and reference examples', () => {
    const { systemPrompt } = loadGongwenPreset()

    for (const heading of ['### 用户事实', '### 政策依据', '### 范文与私人材料']) {
      expect(systemPrompt.includes(heading), heading).toBe(true)
    }
    expect(systemPrompt.includes('不能在润色中相互升级')).toBe(true)
    expect(systemPrompt.includes('不能把其中的姓名、业绩、数字、政策或经历移植为用户事实')).toBe(
      true,
    )
    expect(systemPrompt.includes('不为每份稿件强制检索')).toBe(true)
    expect(systemPrompt.includes('不得假装检索成功')).toBe(true)
    expect(systemPrompt.includes('不作为外部搜索词发送')).toBe(true)
  })

  it('preserves format-only editing and truthful tool-completion requirements', () => {
    const { systemPrompt } = loadGongwenPreset()

    expect(systemPrompt.includes('只要求排版时不改文字，包括标点')).toBe(true)
    expect(systemPrompt.includes('仅处理约定范围')).toBe(true)
    expect(systemPrompt.includes('不强制所有任务先出大纲')).toBe(true)
    expect(systemPrompt.includes('不要用模型自评分')).toBe(true)
    expect(systemPrompt.includes('只有工具成功执行且结果可核对时')).toBe(true)
    expect(systemPrompt.includes('仅在用户明确授权且程序确实提供相应能力时处理')).toBe(true)
  })

  it('does not complete missing facts or requirements with routine assumptions', () => {
    const { systemPrompt } = loadGongwenPreset()

    expect(systemPrompt.includes('材料未提供的后续措施、职责、时限和结果一律不写')).toBe(true)
    expect(systemPrompt.includes('不得把常见流程或惯例写成用户已确认的办理要求')).toBe(true)
    expect(systemPrompt.includes('未提供的成文日期不能取当前日期代填')).toBe(true)
    expect(systemPrompt.includes('用户只给月日时保留原写法')).toBe(true)
    expect(systemPrompt.includes('材料少时仍按现有事实交付简稿')).toBe(true)
  })
})
