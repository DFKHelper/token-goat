#!/usr/bin/env node
/** Builds the native hook client (native/tg-hook) and copies it to dist/native/<platform>-<arch>/tg-hook[.exe], the path the installer will look in. With no arguments it builds for this machine; `--target <triple>` builds one of the release targets instead (the table in scripts/verify-native-dist.mjs), placed under the directory that target installs from, which is how the release workflow builds each binary with the same flags as a local build. `--locked` makes the committed Cargo.lock what ships, and native/tg-hook/rust-toolchain.toml pins the compiler; a cross target must already be added to that toolchain (`rustup target add`). Prints the destination path as the last line of stdout; exits non-zero, saying why, when cargo is missing or the build fails, so a caller never mistakes a stale binary for a fresh one. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NATIVE_TARGETS } from './verify-native-dist.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CRATE_DIR = path.join(ROOT, 'native', 'tg-hook')
const USAGE = 'usage: node scripts/build-native.mjs [--target <triple>]'

function fail(message) {
  process.stderr.write(`build-native: ${message}\n`)
  process.exit(1)
}

let triple
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--target' && triple === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) triple = argv[++i]
  else fail(`unexpected argument ${JSON.stringify(argv[i])}; ${USAGE}`)
}
// Only the shipped triples are accepted, each mapped to the directory the installer computes for it, so a build can never land a binary under a name that disagrees with what it was compiled for.
const target = triple === undefined ? undefined : NATIVE_TARGETS.find((t) => t.triple === triple)
if (triple !== undefined && target === undefined) fail(`--target ${triple} is not a release target; expected one of ${NATIVE_TARGETS.map((t) => t.triple).join(', ')}`)
const platformArch = target?.platformArch ?? `${process.platform}-${process.arch}`
const msvc = target === undefined ? process.platform === 'win32' : target.triple.endsWith('-windows-msvc')
const EXE = msvc ? 'tg-hook.exe' : 'tg-hook'

// rustc writes the absolute source path of every dependency into panic and serde messages, and the MSVC linker the absolute path of the debug file, so without these the binary names the builder's home directory (a username, on a local build) and its bytes change with HOME: a test run that points HOME at a temp directory built a binary that differed from the one install had copied, and doctor reported the copy stale. The later remap wins where two match, so the checkout, which may sit inside the cargo home's parent, is listed last.
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo')
const remap = [`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${CRATE_DIR}=/tg-hook`]
if (msvc) remap.push('-Clink-arg=/PDBALTPATH:%_PDB%', '-Clink-arg=/Brepro')
const inherited = process.env.CARGO_ENCODED_RUSTFLAGS ?? (process.env.RUSTFLAGS ?? '').split(' ').filter(Boolean).join('\x1f')
const rustflags = [inherited, ...remap].filter(Boolean).join('\x1f')

// The artifact path comes from cargo's own JSON messages rather than an assumed target/release/, so a CARGO_TARGET_DIR set in the environment still finds the binary just built.
const result = spawnSync('cargo', ['build', '--release', '--locked', '--message-format=json-render-diagnostics', ...(target === undefined ? [] : ['--target', target.triple])], {
  cwd: CRATE_DIR,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
})
if (result.error) fail(`cargo could not be started (${result.error.message}). Install Rust with rustup; native/tg-hook/rust-toolchain.toml selects the toolchain.`)
if (result.status !== 0) fail(`cargo build exited with ${result.status ?? result.signal}${target === undefined ? '' : `; cargo's error above says why (building for ${target.triple} needs \`rustup target add ${target.triple}\` run inside native/tg-hook, and a linker for that architecture)`}`)

let built
for (const line of result.stdout.split('\n')) {
  if (!line.startsWith('{')) continue
  const message = JSON.parse(line)
  if (message.reason === 'compiler-artifact' && message.target?.name === 'tg-hook' && typeof message.executable === 'string') built = message.executable
}
if (built === undefined || !existsSync(built)) fail('cargo reported no tg-hook executable')

const dest = path.join(ROOT, 'dist', 'native', platformArch, EXE)
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
