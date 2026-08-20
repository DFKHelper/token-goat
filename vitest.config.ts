import * as os from 'node:os'

import { defineConfig } from 'vitest/config'

import { resolveMaxWorkers } from './tests/setup/max-workers.js'
import RetryVisibilityReporter from './tests/setup/retry-visibility-reporter.js'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/isolate-home.ts', './tests/setup/reset-hint-stats.ts'],
    globalSetup: ['./tests/setup/build-bundle.ts'],
    // Never pick up test copies inside agent worktrees (.claude/worktrees/...).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Vitest's 5s default was inherited, never chosen for this suite, and it is too tight here: a full run is 311 files with ~29s of transform and ~62s of prepare, so a test doing ordinary work (a cold module-graph import, one real SQLite round-trip) can blow 5s purely from contention and fail while passing standalone. Two different tests failed that way on consecutive runs, which is a property of the bound rather than of either test. Raising it does not weaken hang detection: nothing here relies on the global bound to catch a hang -- tests that genuinely care about latency assert their own tighter bound explicitly (see cli_statusline.test.ts, which asserts elapsed < 3000ms), and a real hang still fails, just later.
    // The suite has since grown from those 311 files to 430, with ~95s of transform and ~200s of setup, and the bound started biting again at exactly the same place: across six consecutive full runs, two runs each failed one test with "Test timed out in 30000ms" and no assertion failure anywhere -- `parser_markdown_closing_hash.test.ts` in one, `languages.test.ts > csharp adapter` in another. Both are one `parseFile` call over a few lines of fixture, both complete in about 1.6s standalone, and both were the first call in their worker to load their language's grammar. Confirmed as a property of the bound rather than of this change by reverting the change entirely and reproducing the same shape in a different unrelated file. Same reasoning as the 5s -> 30s raise above, same evidence, one size larger.
    testTimeout: 60000,
    hookTimeout: 60000,
    // CI-only: rerun a failing test once before reporting it. Absorbs a genuinely transient
    // infra-level flake (a shared runner's fork/worker RPC losing a heartbeat under load,
    // surfacing as "[vitest-worker]: Timeout calling 'onTaskUpdate'" with no assertion failure
    // anywhere in the run) rather than a real regression, which fails the same way
    // deterministically and still gets reported after the retry. Distinct from the workflow's
    // own nick-fields/retry, which re-runs the ENTIRE suite: that re-pays the whole run's
    // contention, so one slow test can sink all three attempts, which is exactly what happened
    // when this was removed. Left off locally so a real local failure is never silently retried
    // away mid-development.
    retry: process.env.CI ? 1 : 0,
    // Keep the default reporter and add one that makes a CONSUMED retry visible. The retry above
    // is deliberate, but it is also a flake-hiding mechanism by construction -- a test that fails
    // then passes reads exactly like one that passed first time -- so without this a real flake
    // can live in the suite indefinitely. The reporter never fails the build (that would undo the
    // retry) and emits nothing at all when no test was retried.
    reporters: ['default', new RetryVisibilityReporter()],
    pool: 'forks',
    minWorkers: 1,
    // Derived from the machine: the known-stable 4 (Windows) / 6 (Linux, macOS) on anything the
    // size of a CI runner, more only on a machine large enough that the heap exhaustion those
    // numbers protect against cannot recur. Why those numbers and where the bar sits:
    // tests/setup/max-workers.ts.
    maxWorkers: resolveMaxWorkers(process.platform, os.cpus().length, os.totalmem() / 2 ** 30),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
    },
  },
})
