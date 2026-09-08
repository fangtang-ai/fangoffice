import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESETS, composePresetCatalog, presetsForApp } from '../src/presets'

describe('composePresetCatalog', () => {
  it('returns the compiled-in catalog untouched when no files exist', () => {
    expect(composePresetCatalog(BUILTIN_PRESETS, [])).toEqual([...BUILTIN_PRESETS])
  })

  it('file presets replace a whole app: other apps keep their compiled-in entries', () => {
    const files = [
      {
        app: 'docs',
        id: 'docs-fangtang-gongwen',
        name: '方塘公文写作',
        nameEn: 'FangTang official-document writing',
        description: '党政机关公文写作',
        systemPrompt: '生成公文时…',
      },
      {
        app: 'docs',
        id: 'docs-fangtang-keyan',
        name: '方塘可研写作',
        systemPrompt: '生成可研报告时…',
      },
    ]
    const catalog = composePresetCatalog(BUILTIN_PRESETS, files)
    const docs = catalog.filter((p) => p.app === 'docs')
    // exactly the two file presets — no compiled-in docs entries remain
    expect(docs.map((p) => p.id)).toEqual(['docs-fangtang-gongwen', 'docs-fangtang-keyan'])
    // slides/sheets/pdf/markdown keep their compiled-in sets
    expect(catalog.filter((p) => p.app === 'slides').length).toBe(presetsForApp('slides').length)
    expect(catalog.filter((p) => p.app === 'sheets').length).toBe(presetsForApp('sheets').length)
  })

  it('accepts a file-only app and applies optional fields sparingly', () => {
    const catalog = composePresetCatalog(BUILTIN_PRESETS, [
      { app: 'slides', id: 'slides-extra', name: 'extra', systemPrompt: 'x', mcpServers: [] },
    ])
    const extra = catalog.find((p) => p.id === 'slides-extra')
    expect(extra).toMatchObject({ app: 'slides', name: 'extra', systemPrompt: 'x' })
    expect('mcpServers' in extra!).toBe(false)
    expect('nameEn' in extra!).toBe(false)
  })
})
