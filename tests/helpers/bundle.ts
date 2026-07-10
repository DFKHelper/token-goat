import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(HERE, '..', '..')
export const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')
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
