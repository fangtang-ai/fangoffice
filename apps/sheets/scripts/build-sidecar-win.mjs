#!/usr/bin/env node
// Cross-compile the xlsx-sidecar for Windows (x64, GNU toolchain) from macOS:
// `dist:win` from a Mac packages the exe produced here. Requires once:
//   brew install mingw-w64
//   rustup target add x86_64-pc-windows-gnu
// (the linker is preconfigured in native/xlsx-engine/.cargo/config.toml)

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cargoOrFail } from './lib/cargo-resolve.mjs'

/** rustup sits next to cargo in rustup-managed installs; null otherwise. */
function findRustup(cargo) {
  const besideCargo = join(dirname(cargo), 'rustup')
  if (existsSync(besideCargo)) return besideCargo
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const dir of pathDirs) {
    const candidate = join(dir, 'rustup')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function fatal(msg) {
  console.error(`[sidecar-win] ERROR: ${msg}`)
  process.exit(1)
}

const sheetsDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'x86_64-pc-windows-gnu'
const out = join(sheetsDir, 'native/xlsx-engine/target', TARGET, 'release/xlsx-sidecar.exe')

const cargo = cargoOrFail()

// the target's rust-std is required for cross-compiling; add it on demand so a
// fresh toolchain works without a separate manual step. rustup is a separate
// binary (next to cargo in rustup-managed installs); without it, try the build
// and let cargo report a missing target itself.
const rustup = findRustup(cargo)
const installed = rustup
  ? execFileSync(rustup, ['target', 'list', '--installed'], { encoding: 'utf8' })
  : ''
if (!installed.includes(TARGET)) {
  if (!rustup) fatal(`rust-std for ${TARGET} is not installed and no rustup found to add it`)
  console.log(`[sidecar-win] rustup target add ${TARGET}`)
  execFileSync(rustup, ['target', 'add', TARGET], { stdio: 'inherit' })
}

console.log(`[sidecar-win] cargo build --target ${TARGET}`)
// cargo resolves --config relative to the cwd, so run from apps/sheets exactly
// like the other native:build scripts
execFileSync(
  cargo,
  [
    'build',
    '--release',
    '--manifest-path',
    'native/xlsx-engine/Cargo.toml',
    '--config',
    'native/xlsx-engine/.cargo/config.toml',
    '--target',
    TARGET,
  ],
  { cwd: sheetsDir, stdio: 'inherit' },
)

if (!existsSync(out)) fatal(`build reported success but ${out} is missing`)
console.log(`[sidecar-win] ${out} ready`)
