#!/usr/bin/env node
/** Builds the native hook client (native/tg-hook) for this machine and copies it to dist/native/<platform>-<arch>/tg-hook[.exe], the path the installer will look in. `--locked` makes the committed Cargo.lock what ships, and native/tg-hook/rust-toolchain.toml pins the compiler, which rustup installs on first use. Prints the destination path as the last line of stdout; exits non-zero, saying why, when cargo is missing or the build fails, so a caller never mistakes a stale binary for a fresh one. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CRATE_DIR = path.join(ROOT, 'native', 'tg-hook')
const EXE = process.platform === 'win32' ? 'tg-hook.exe' : 'tg-hook'

function fail(message) {
  process.stderr.write(`build-native: ${message}\n`)
  process.exit(1)
}

// The artifact path comes from cargo's own JSON messages rather than an assumed target/release/, so a CARGO_TARGET_DIR set in the environment still finds the binary just built.
const result = spawnSync('cargo', ['build', '--release', '--locked', '--message-format=json-render-diagnostics'], {
  cwd: CRATE_DIR,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
})
if (result.error) fail(`cargo could not be started (${result.error.message}). Install Rust with rustup; native/tg-hook/rust-toolchain.toml selects the toolchain.`)
if (result.status !== 0) fail(`cargo build exited with ${result.status ?? result.signal}`)

let built
for (const line of result.stdout.split('\n')) {
  if (!line.startsWith('{')) continue
  const message = JSON.parse(line)
  if (message.reason === 'compiler-artifact' && message.target?.name === 'tg-hook' && typeof message.executable === 'string') built = message.executable
}
if (built === undefined || !existsSync(built)) fail('cargo reported no tg-hook executable')

const dest = path.join(ROOT, 'dist', 'native', `${process.platform}-${process.arch}`, EXE)
mkdirSync(path.dirname(dest), { recursive: true })
// An identical binary is left alone, so a rebuild with nothing to do never touches a copy that may be running. A changed one is staged beside the destination and renamed over it, so no reader ever sees half a file.
if (!existsSync(dest) || !readFileSync(dest).equals(readFileSync(built))) {
  const staged = `${dest}.${process.pid}.tmp`
  try {
    copyFileSync(built, staged)
    renameSync(staged, dest)
  } catch (e) {
    rmSync(staged, { force: true })
    fail(`cannot install ${dest}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
process.stdout.write(`${dest}\n`)
