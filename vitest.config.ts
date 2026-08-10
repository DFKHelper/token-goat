import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/isolate-home.ts', './tests/setup/reset-hint-stats.ts'],
    globalSetup: ['./tests/setup/build-bundle.ts'],
    // Never pick up test copies inside agent worktrees (.claude/worktrees/...).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // CI-only: rerun a failing test once before reporting it, to absorb a genuinely transient
    // infra-level flake (a shared CI runner's fork/worker RPC losing a heartbeat under load,
    // surfacing as "[vitest-worker]: Timeout calling 'onTaskUpdate'" with no assertion failure
    // anywhere in the run) rather than a real regression. A real regression fails the same way
    // deterministically and still gets reported after the retry; only genuinely load-dependent
    // failures are absorbed. Left off locally so a real local failure is never silently retried
    // away mid-development.
    retry: process.env.CI ? 1 : 0,
    // Vitest's 5s default was inherited, never chosen for this suite, and it is too tight here: a full run is 311 files with ~29s of transform and ~62s of prepare, so a test doing ordinary work (a cold module-graph import, one real SQLite round-trip) can blow 5s purely from contention and fail while passing standalone. Two different tests failed that way on consecutive runs, which is a property of the bound rather than of either test. Raising it does not weaken hang detection: nothing here relies on the global bound to catch a hang -- tests that genuinely care about latency assert their own tighter bound explicitly (see cli_statusline.test.ts, which asserts elapsed < 3000ms), and a real hang still fails, just later.
    testTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
        minForks: 1,
        maxForks: 4,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
    },
  },
})
