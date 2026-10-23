import type { ScopeGitDeps } from '../../src/inline_grep_scan.js'
import { runGit } from '../../src/util.js'

// HAND-DERIVED: the git calls of one scope decision share a 5000 ms wall-clock deadline (SCOPE_GIT_TIMEOUT_MS in inline_grep_scan.ts), which a row that expects an ANSWER must not depend on: on a loaded machine each real git call took 0.5 to 2 s, the later calls of one decision were handed what was left, and one ran out (a measured run: `ls-files` given 999 ms and 1882 ms, ETIMEDOUT, so the Grep passed). The deadline's own behaviour is pinned with an injected clock in tests/inline_grep_scan_git_budget.test.ts.

/** The most one real git call may take in a row that is not about the deadline; a hung git still ends, and well inside the 60 s a test may run. */
const STEADY_CALL_MS = 50_000

/** Deps for a row about the answer, not the deadline: a clock that never moves, so the shared deadline never passes, and a per-call bound far past anything load does. */
export const steadyScopeDeps: ScopeGitDeps = {
  git: (args, opts) => runGit(args, { ...opts, timeoutMs: STEADY_CALL_MS }),
  now: () => 0,
}
