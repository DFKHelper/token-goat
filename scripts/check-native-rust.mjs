#!/usr/bin/env node
/** Pre-commit Rust format and clippy gate for native/tg-hook, resolving cargo.exe on Windows when PATH only exposes a cargo.cmd wrapper or rustup lives in CARGO_HOME. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CRATE_DIR = path.join(ROOT, 'native', 'tg-hook')
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo')

function resolveCargoExe() {
  if (process.platform !== 'win32') return 'cargo'
  const pathVal = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? ''
  for (const dir of pathVal.split(path.delimiter).filter(Boolean)) {
    if (existsSync(path.join(dir, 'cargo.exe'))) return path.join(dir, 'cargo.exe')
    if (existsSync(path.join(dir, 'cargo.cmd')) || existsSync(path.join(dir, 'cargo.bat'))) {
      const candidate = path.join(cargoHome, 'bin', 'cargo.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  const fallback = path.join(cargoHome, 'bin', 'cargo.exe')
  return existsSync(fallback) ? fallback : 'cargo'
}

const cargo = resolveCargoExe()
for (const args of [
  ['fmt', '--', '--check'],
  ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
]) {
  const result = spawnSync(cargo, args, { cwd: CRATE_DIR, stdio: 'inherit', windowsHide: true })
  if (result.error) {
    process.stderr.write(`rust-lint: failed to start ${cargo}: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
