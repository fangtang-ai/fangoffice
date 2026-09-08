import { describe, expect, it } from 'vitest'
import { parsePresetMarkdown } from '../src/preset-files'

describe('parsePresetMarkdown', () => {
  it('parses frontmatter metadata and keeps the body as the playbook', () => {
    const preset = parsePresetMarkdown(
      'docs',
      '周报.md',
      [
        '---',
        'id: docs-weekly',
        'name: 周报',
        'nameEn: Weekly report',
        'description: 结构化周报',
        'mcpServers: erp, wiki',
        '---',
        '',
        '生成周报时遵循：',
        '1. 本周完成',
      ].join('\n'),
    )
    expect(preset).toMatchObject({
      app: 'docs',
      id: 'docs-weekly',
      name: '周报',
      nameEn: 'Weekly report',
      description: '结构化周报',
      mcpServers: ['erp', 'wiki'],
      systemPrompt: '生成周报时遵循：\n1. 本周完成',
    })
  })

  it('falls back to the filename for id and name without frontmatter', () => {
    const preset = parsePresetMarkdown('docs', '方塘AI公文写作.md', '# Role: 写作助手\n\n正文')
    expect(preset).toMatchObject({ app: 'docs', id: '方塘AI公文写作', name: '方塘AI公文写作' })
    expect(preset!.systemPrompt).toContain('写作助手')
  })

  it('tolerates colons inside values and ignores unknown keys', () => {
    const preset = parsePresetMarkdown(
      'docs',
      'x.md',
      ['---', 'description: 结构：一、二、三', 'unknownKey: whatever', '---', '正文'].join('\n'),
    )
    expect(preset!.description).toBe('结构：一、二、三')
  })

  it('returns null for an empty playbook', () => {
    expect(parsePresetMarkdown('docs', 'empty.md', '---\nid: x\n---\n\n')).toBeNull()
    expect(parsePresetMarkdown('docs', '.md', 'body')).toBeNull()
  })
})
