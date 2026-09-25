/** Builds the native hook client with scripts/build-native.mjs, the same way tests/native_hook_conformance.test.ts does, and returns the path of the binary it installed under dist/native. Fails rather than skips where cargo is missing: CI installs the pinned toolchain on every platform. */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

import { ROOT } from './bundle.js'

export function buildNative(): string {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-native.mjs')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`scripts/build-native.mjs failed (exit ${String(r.status)}); these tests need the Rust toolchain pinned in native/tg-hook/rust-toolchain.toml.\n${r.stderr}${r.error?.message ?? ''}`)
  return r.stdout.trim().split(/\r?\n/).pop() ?? ''
}
