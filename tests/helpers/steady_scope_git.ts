import type { ScopeGitDeps } from '../../src/inline_grep_scan.js'

// HAND-DERIVED: the git calls of one scope decision share a 5000 ms wall-clock deadline (SCOPE_GIT_TIMEOUT_MS in inline_grep_scan.ts), which a row that expects an ANSWER must not depend on: on a loaded machine each real git call took 0.5 to 2 s, the later calls of one decision were handed what was left, and one ran out (a measured run: `ls-files` given 999 ms and 1882 ms, ETIMEDOUT, so the Grep passed). The deadline's own behaviour is pinned with an injected clock in tests/inline_grep_scan_git_budget.test.ts.

/** Deps for a row about the answer, not the deadline: the production git, and a clock that never moves, so every call gets the whole per-call bound and the shared deadline never passes. Nothing is lengthened. */
export const steadyScopeDeps: ScopeGitDeps = { now: () => 0 }

/** A vi.mock factory body for '../src/inline_grep_scan.js': the module with readScopeDir defaulting to {@link steadyScopeDeps}. */
export function withSteadyScopeDeps<T extends { readScopeDir: (dir: string, root: string, deps?: ScopeGitDeps) => unknown }>(real: T): T {
  return { ...real, readScopeDir: (dir: string, root: string, deps: ScopeGitDeps = steadyScopeDeps) => real.readScopeDir(dir, root, deps) }
}
