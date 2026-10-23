import type { ScopeGitDeps } from '../../src/inline_grep_scan.js'

// The git calls of one scope decision share a 5000 ms wall-clock deadline (SCOPE_GIT_TIMEOUT_MS in inline_grep_scan.ts); rows that expect an answer inject a frozen clock so they do not depend on wall time, and the deadline itself is pinned in tests/inline_grep_scan_git_budget.test.ts.

/** Deps for a row about the answer, not the deadline: the production git, and a clock that never moves, so every call gets the whole per-call bound and the shared deadline never passes. Nothing is lengthened. */
export const steadyScopeDeps: ScopeGitDeps = { now: () => 0 }

/** A vi.mock factory body for '../src/inline_grep_scan.js': the module with readScopeDir defaulting to {@link steadyScopeDeps}. */
export function withSteadyScopeDeps<T extends { readScopeDir: (dir: string, root: string, deps?: ScopeGitDeps) => unknown }>(real: T): T {
  return { ...real, readScopeDir: (dir: string, root: string, deps: ScopeGitDeps = steadyScopeDeps) => real.readScopeDir(dir, root, deps) }
}
