#!/usr/bin/env node
// `native:build` / `native:test` entry: runs cargo with extra PATH entries so
// a rustup install is found even when $HOME/.cargo/bin is not on PATH (GUI
// launches, shells older than the install).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { cargoOrFail } from './lib/cargo-resolve.mjs'

const [, , command, ...args] = process.argv
if (!command) {
  console.error('usage: run-cargo.mjs <cargo-command> [args...]')
  process.exit(1)
}

// extra PATH entries so a rustup install is found even when ~/.cargo/bin is
// not on PATH (GUI launches, shells older than the install)
const extraDirs = [
  process.env.HOME && join(process.env.HOME, '.cargo', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
].filter((dir) => dir && existsSync(dir))

const result = spawnSync(cargoOrFail(), [command, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${extraDirs.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`,
  },
})
process.exit(result.status ?? 1)
