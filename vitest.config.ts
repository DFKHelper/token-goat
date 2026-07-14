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
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
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
