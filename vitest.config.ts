import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/isolate-home.ts', './tests/setup/reset-hint-stats.ts'],
    globalSetup: ['./tests/setup/build-bundle.ts'],
    // Never pick up test copies inside agent worktrees (.claude/worktrees/...).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    // Vitest's 5s default was inherited, never chosen for this suite, and it is too tight here: a full run is 311 files with ~29s of transform and ~62s of prepare, so a test doing ordinary work (a cold module-graph import, one real SQLite round-trip) can blow 5s purely from contention and fail while passing standalone. Two different tests failed that way on consecutive runs, which is a property of the bound rather than of either test. Raising it does not weaken hang detection: nothing here relies on the global bound to catch a hang -- tests that genuinely care about latency assert their own tighter bound explicitly (see cli_statusline.test.ts, which asserts elapsed < 3000ms), and a real hang still fails, just later.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 6,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
    },
  },
})
