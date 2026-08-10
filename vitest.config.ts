import { defineConfig } from 'vitest/config'

import RetryVisibilityReporter from './tests/setup/retry-visibility-reporter.js'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/isolate-home.ts', './tests/setup/reset-hint-stats.ts'],
    globalSetup: ['./tests/setup/build-bundle.ts'],
    // Never pick up test copies inside agent worktrees (.claude/worktrees/...).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Vitest's 5s default was inherited, never chosen for this suite, and it is too tight here: a full run is 311 files with ~29s of transform and ~62s of prepare, so a test doing ordinary work (a cold module-graph import, one real SQLite round-trip) can blow 5s purely from contention and fail while passing standalone. Two different tests failed that way on consecutive runs, which is a property of the bound rather than of either test. Raising it does not weaken hang detection: nothing here relies on the global bound to catch a hang -- tests that genuinely care about latency assert their own tighter bound explicitly (see cli_statusline.test.ts, which asserts elapsed < 3000ms), and a real hang still fails, just later.
    testTimeout: 30000,
    hookTimeout: 30000,
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
    // 6 forked workers oversubscribe GitHub's 4-vCPU windows-latest runner by 50%, and Windows
    // process spawn is far more expensive than Linux while this suite spawns the built bundle in
    // many tests. That combination pushed ordinary tests past the 30s bound -- a sqlite cap test
    // took 51s and 55s, and two suites died in hooks -- across all three workflow attempts, while
    // ubuntu and macOS absorbed 6 workers fine. 4 is the value this suite was green on before.
    // Scoped to CI, not to Windows generally: the constraint is the runner's core count, not the
    // OS, so a developer's many-core Windows box keeps the full 6 (capping it there cost 58% of
    // wall clock locally -- 219s to 346s -- for no benefit).
    maxWorkers: process.platform === 'win32' && process.env.CI ? 4 : 6,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
    },
  },
})
