import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/isolate-home.ts'],
    // Never pick up test copies inside agent worktrees (.claude/worktrees/...).
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
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
