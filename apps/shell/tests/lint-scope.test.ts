import { resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

describe('workspace lint scope', () => {
  it('excludes local build archives without excluding application source or E2E tests', async () => {
    const eslint = new ESLint({ cwd: resolve(__dirname, '../../..') })
    expect(await eslint.isPathIgnored('tmp/add-account-strings.cjs')).toBe(true)
    expect(await eslint.isPathIgnored('tools/format-changed.mjs')).toBe(false)
    expect(
      await eslint.isPathIgnored('.local/archive/win-unpacked/resources/generated-main.js'),
    ).toBe(true)
    expect(await eslint.isPathIgnored('apps/markdown/src/renderer/ai/AiPanel.tsx')).toBe(false)
    expect(await eslint.isPathIgnored('e2e/mcp-paid-gates.spec.ts')).toBe(false)
  })
})
