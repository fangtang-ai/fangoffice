#!/usr/bin/env node
// English-only guard for tracked code comments and documentation prose.
// ENGLISH_COMMENT_BASE_REF limits the check to added lines; without a base,
// audit the whole repository.
//
// Functional CJK string literals are fine (i18n resources, test fixture
// text, zh-UI matchers), as are the AI prompt guides (runtime resources that
// legitimately show CJK examples).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HAN = /[\u3400-\u9fff]/

function git(args) {
  const result = spawnSync('git', ['--literal-pathspecs', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    console.error(result.error?.message ?? result.stderr)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}

const root = git(['rev-parse', '--show-toplevel']).trim()
process.chdir(root)
const baseRef = process.env.ENGLISH_COMMENT_BASE_REF
if (baseRef) git(['rev-parse', '--verify', `${baseRef}^{commit}`])
const files = git(
  baseRef
    ? ['diff', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-z', baseRef, '--']
    : ['ls-files', '-z'],
)

const violations = []
for (const file of files.split('\0').filter(Boolean)) {
  const isCode = /\.(ts|tsx|mjs|cjs|js)$/.test(file)
  const isDoc = /\.(md|html?)$/.test(file) && !file.includes('/ai/prompts/')
  if (!isCode && !isDoc) continue
  const addedLines = new Set()
  if (baseRef) {
    const diff = git([
      'diff',
      '--unified=0',
      '--no-ext-diff',
      '--no-color',
      '--no-renames',
      baseRef,
      '--',
      file,
    ])
    // Zero-context hunks identify new line numbers without parsing quoted paths.
    for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]) - 1
      const count = Number(match[2] ?? 1)
      for (let index = start; index < start + count; index++) addedLines.add(index)
    }
  }
  const lines = (await readFile(join(root, file), 'utf8')).split('\n')
  lines.forEach((line, index) => {
    if (baseRef && !addedLines.has(index)) return
    const text = isDoc
      ? line
      : (line.match(/(?:^|[^:'"])\/\/(.*)$/) ??
          line.match(/^\s*\*(.*)$/) ??
          line.match(/\/\*(.*)$/))?.[1]
    if (text !== undefined && HAN.test(text)) {
      violations.push(`  ${file}:${index + 1}: ${line.trim()}`)
    }
  })
}

if (violations.length > 0) {
  console.error(
    `Chinese text found in code comments or docs:\n${violations.join('\n')}\n` +
      'Comments and documentation must be English-only. Move CJK text into ' +
      'string literals or rewrite the comment in English.',
  )
  process.exit(1)
}
console.log('check-english-comments: OK')
