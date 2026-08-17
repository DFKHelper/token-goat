import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(HERE, '..', '..')
export const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')
// The code itself. BUNDLE is only a launcher that enables the V8 compile cache before importing
// this file (see esbuild.config.mjs), so any assertion about what survived bundling -- a symbol
// being present, a stub being absent -- must read CORE_BUNDLE. Reading BUNDLE for that would pass
// or fail on a few hundred bytes of launcher that contain none of the product code.
export const CORE_BUNDLE = path.join(ROOT, 'dist', 'token-goat.core.mjs')
// Prefix of the core build's hashed code chunks -- must match esbuild.config.mjs's CORE_CHUNK_PREFIX.
const CORE_CHUNK_PREFIX = 'token-goat-chunk-'

/**
 * All of the core build's emitted code, as one string: the entry plus every chunk.
 *
 * The core build uses `splitting: true`, so CORE_BUNDLE itself is a few hundred bytes that import
 * the chunks holding the product code. An assertion about what survived bundling -- a symbol being
 * present, a stub being absent -- must therefore read the whole emitted set, not the entry alone,
 * or it fails on every symbol whichever way the code is arranged.
 */
export function readCoreBundleText(): string {
  const dist = path.join(ROOT, 'dist')
  const parts = [fs.readFileSync(CORE_BUNDLE, 'utf8')]
  for (const f of fs.readdirSync(dist)) {
    if (f.startsWith(CORE_CHUNK_PREFIX)) parts.push(fs.readFileSync(path.join(dist, f), 'utf8'))
  }
  return parts.join('\n')
}
// The in-process hook library bundle (src/hook_lib.ts) -- a sibling of BUNDLE with zero
// load-time side effects, exporting relayInProcess() for bridges to import() directly
// instead of spawnSync-ing a second `token-goat hook <event>` process. See esbuild.config.mjs.
export const HOOK_BUNDLE = path.join(ROOT, 'dist', 'token-goat-hook.mjs')

export interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export function runCli(args: string[], input = ''): RunResult {
  // Spawn the prebuilt bundle directly with node - no per-call tsx transpile (much faster than --import tsx across dozens of spawns) and it exercises the real shipping artifact. No shell, so no .cmd-shim or quoting issues on Windows.
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    input,
    encoding: 'utf8',
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}
