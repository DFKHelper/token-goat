import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.join(HERE, '..', '..')
export const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

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
