/**
 * Global test isolation for hint_stats.ts's suppression state.
 *
 * `applyHintTracking` (wired into preBashHandler/preReadHandler/postReadHandler/postEditHandler)
 * writes every hint emission into the shared `hint_emissions` table in the per-worker global.db
 * that isolate-home.ts already isolates by PID (see that file's doc comment). That isolation is
 * per WORKER, not per TEST FILE or per TEST: with `pool: 'forks'` + `singleFork: false`, many
 * unrelated test files (hooks_bash.test.ts, shell_quote_hint.test.ts, ...) run inside the same
 * forked process and therefore share the same global.db across the whole run.
 *
 * `shouldSuppress` is a deliberately conservative, disclosed policy (see hint_stats.ts's module
 * doc comment): a hint whose text carries no extractable path/id correlator is counted as
 * "no signal available" toward the suppression denominator, on the reasoning that a category
 * which can never demonstrate follow-through should eventually stop firing. That is intentional
 * production behavior (and is itself covered by hint_stats.test.ts's
 * "suppresses once both the sample-size floor and the efficacy threshold are crossed" case using
 * exactly this kind of data) -- but it means ANY test file that repeatedly triggers a
 * no-correlator hint (e.g. shell_quote_hint.test.ts's "unclosed quote"/"unterminated heredoc"
 * messages, which have nothing to point at) can, within a shared worker, silently push
 * `bash_redirect` (or any other category) past `hint_stats.min_sample_size` at 0% efficacy. Once
 * that happens, EVERY subsequent test in that worker that expects a `context` hint back from
 * preBashHandler instead gets `passOutput()` -- a real, observed nondeterministic failure
 * (reproduced: a full `npm test` run failed 111 assertions across 4 unrelated hook test files
 * with `expected 'pass' to be 'context'`; a subsequent identical run passed clean, confirming
 * this is scheduling-order-dependent cross-file contamination, not a flaw in any individual
 * test's own logic).
 *
 * Fix: reset hint_stats' own tables before every single test, at the outermost hook scope, so
 * no test's hint emissions can ever leak into another test's suppression state — matching the
 * existing per-worker DATA_DIR/TOKEN_GOAT_HOME isolation pattern in isolate-home.ts, just scoped
 * one level finer (per-test instead of per-worker) because hint suppression state accumulates
 * fast enough to cross its own threshold within a single worker's test file queue.
 *
 * The `resetHintStats`/`closeDb` imports are dynamic (inside the hook body, not static top-level
 * imports) so this file never forces src/db.ts (and its DATA_DIR-reading transitive imports) to
 * initialize before isolate-home.ts's synchronous top-level code has already pointed
 * LOCALAPPDATA/XDG_DATA_HOME/TOKEN_GOAT_HOME at this worker's temp dirs — a static import here
 * would be hoisted ahead of that env-var setup and read the developer's real data dir instead.
 *
 * Guarded by `fs.existsSync(dbPath)` first: `resetHintStats` calls `getDb()`, which OPENS (and,
 * if absent, CREATES) global.db. If global.db doesn't exist yet there is nothing to reset — and,
 * critically, this hook must not be the thing that creates it: tests/hooks_index.test.ts's "does
 * not open or create the global index DB on a plain append" regression test asserts global.db
 * stays completely absent for certain code paths, then `fs.rmSync`s it itself mid-test.
 *
 * Just as critically, this hook closes the connection it opens (via `closeDb`) before returning,
 * rather than leaving it cached in db.ts's process-wide `_connections` map for some later
 * `clearModuleCaches()` call to close. db.ts/reset.ts and their `_connections`/`_resets` module
 * state are genuine singletons shared by every test file that runs inside the same vitest worker
 * (isolate-home.ts's per-PID DATA_DIR isolation is per-WORKER, not per-file), so a connection
 * left open here can still be live when a *different* test file's own code later tries to
 * `fs.rmSync` that same shared global.db, which fails with `EPERM` on Windows (a file with an
 * open handle cannot be deleted) -- reproduced exactly this way against
 * tests/hooks_index.test.ts's regression test above when an earlier version of this hook left
 * its connection open for some later beforeEach/clearModuleCaches() call to (hopefully) close,
 * instead of closing it itself.
 */
import * as fs from 'node:fs'
import { beforeEach } from 'vitest'

beforeEach(async () => {
  try {
    const { globalDbPath } = await import('../../src/constants.js')
    const dbPath = globalDbPath()
    if (!fs.existsSync(dbPath)) return
    const { resetHintStats } = await import('../../src/hint_stats.js')
    const { closeDb } = await import('../../src/db.js')
    resetHintStats()
    closeDb(dbPath)
  } catch {
    // Best-effort: never fail an unrelated test over hint-stats cleanup.
  }
})
