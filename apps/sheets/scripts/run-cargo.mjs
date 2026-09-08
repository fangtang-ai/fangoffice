#!/usr/bin/env node
// `native:build` / `native:test` entry: runs cargo with extra PATH entries so
// a rustup install is found even when $HOME/.cargo/bin is not on PATH (GUI
// launches, shells older than the install).
import { spawnSync } from 'node:child_process'
import { cargoOrFail } from './lib/cargo-resolve.mjs'

const [, , command, ...args] = process.argv
if (!command) {
  console.error('usage: run-cargo.mjs <cargo-command> [args...]')
  process.exit(1)
}

const result = spawnSync(cargoOrFail(), [command, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${process.env.HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
  },
})
process.exit(result.status ?? 1)
