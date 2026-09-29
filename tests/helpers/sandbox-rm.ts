/** Recursive delete for a path a test derived from `os.homedir()`. Those deletes are safe only because tests/setup/isolate-home.ts points HOME/USERPROFILE at a per-file directory under the run root, and nothing at the call site says so: run the same file without that setup (another vitest config, a bare `node --test`, a setup that threw half way) and `rmSync(path.join(os.homedir(), '.claude'))` removes the developer's real Claude Code home -- hooks, credentials and every transcript. The real `~/.claude` on the maintainer's machine was deleted during a full-suite run on 2026-09-28 by a cause that was never reproduced, so this refuses rather than trusts: the target must sit strictly inside TG_TEST_RUN_ROOT (set by globalSetup, never by a developer's shell), and must not be, or contain, the real home isolate-home stashed under TG_REAL_*. */
import * as fs from 'node:fs'
import * as path from 'node:path'

function norm(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Why `target` may not be deleted, or null when it may. Exported so the refusal itself is testable without deleting anything. */
export function sandboxRmRefusal(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env['TG_TEST_RUN_ROOT']
  if (!root) return `refusing to delete ${target}: TG_TEST_RUN_ROOT is unset, so the suite's home sandbox is not in effect`
  if (!isInside(target, root)) return `refusing to delete ${target}: it is not inside the test run root ${root}`
  for (const key of ['TG_REAL_HOME', 'TG_REAL_USERPROFILE', 'TG_REAL_CLAUDE_CONFIG_DIR'] as const) {
    const real = env[key]
    if (real && (norm(real) === norm(target) || isInside(real, target))) return `refusing to delete ${target}: it is or contains the real ${key.slice('TG_REAL_'.length)} ${real}`
  }
  return null
}

/** `fs.rmSync(target, { recursive: true, force: true })`, but only inside the test sandbox. Throws instead of deleting anywhere else. */
export function rmInSandbox(target: string): void {
  const refusal = sandboxRmRefusal(target)
  if (refusal) throw new Error(refusal)
  fs.rmSync(target, { recursive: true, force: true })
}
