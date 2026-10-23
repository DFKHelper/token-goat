import type { ScopeGitDeps } from '../../src/inline_grep_scan.js'
import { GIT_UNBOUNDED, runGit } from '../../src/util.js'

// The git calls of one scope decision share a 5000 ms wall-clock deadline (SCOPE_GIT_TIMEOUT_MS in inline_grep_scan.ts); rows that expect an answer inject a frozen clock so they do not depend on wall time, and the deadline itself is pinned in tests/inline_grep_scan_git_budget.test.ts.

// The shared deadline is only half of the wall-clock dependence: each call also carries the time left as its own spawn bound, and a git that misses it reads as unfinished. So the steady git is the production runGit with that bound lifted, and the rows that pin the bound itself (tests/inline_grep_scan_git_budget.test.ts) and the built bundle (tests/inline_symbol_answer_scope_bundle.test.ts, default git path) do not use it.

/** Deps for a row about the answer, not the deadline: the production git with no per-call bound, and a clock that never moves, so git always finishes and the shared deadline never passes. */
export const steadyScopeDeps: ScopeGitDeps = { now: () => 0, git: (args, opts) => runGit(args, { ...opts, timeoutMs: GIT_UNBOUNDED }) }

/** A vi.mock factory body for '../src/inline_grep_scan.js': the module with readScopeDir defaulting to {@link steadyScopeDeps}. */
export function withSteadyScopeDeps<T extends { readScopeDir: (dir: string, root: string, deps?: ScopeGitDeps) => unknown }>(real: T): T {
  return { ...real, readScopeDir: (dir: string, root: string, deps: ScopeGitDeps = steadyScopeDeps) => real.readScopeDir(dir, root, deps) }
}
