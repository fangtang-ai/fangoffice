#!/usr/bin/env node
// Resolve the cargo executable even when it is not on PATH: rustup installs
// to ~/.cargo/bin, which GUI-launched processes and shells that predate the
// install never see. Order: PATH first, then the usual install locations.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FALLBACKS = [
  join(homedir(), '.cargo', 'bin', 'cargo'),
  '/opt/homebrew/bin/cargo',
  '/usr/local/bin/cargo',
]

/** @returns {string | null} absolute path to a usable cargo, or null when no Rust toolchain exists */
export function findCargo() {
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = join(dir, 'cargo')
    if (existsSync(candidate)) return candidate
  }
  for (const candidate of FALLBACKS) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** @returns {string} cargo, with a helpful build-blocking message when Rust is missing */
export function cargoOrFail() {
  const cargo = findCargo()
  if (!cargo) {
    console.error(
      '[cargo] Rust toolchain not found. Install it, then restart the terminal:\n' +
        "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal\n" +
        '  source "$HOME/.cargo/env"',
    )
    process.exit(1)
  }
  return cargo
}
