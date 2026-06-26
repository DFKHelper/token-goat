import { describe, expect, it } from 'vitest'

import {
  getMonitoringRecallHint,
  MONITORING_COMMAND_PATTERNS,
} from '../src/hints/lang_patterns.js'

describe('MONITORING_COMMAND_PATTERNS', () => {
  it('exports a non-empty array', () => {
    expect(MONITORING_COMMAND_PATTERNS.length).toBeGreaterThan(0)
  })
})

describe('getMonitoringRecallHint', () => {
  it.each([
    // GitHub CI
    'gh run watch',
    'gh run view',
    'gh run list',
    'gh run view --log',
    'gh pr checks',
    'gh workflow run',
    'gh workflow list',
    'gh workflow view',
  ])('matches GitHub CI command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'next dev',
    'npx next dev',
    'next build',
    'npx next build',
    'vite',
    'vite dev',
    'vite build',
    'vite preview',
    'npx vite',
    'nuxt dev',
    'npx nuxt dev',
    'remix dev',
    'npx remix dev',
    'astro dev',
    'npx astro dev',
  ])('matches dev server command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'vitest',
    'vitest run',
    'vitest watch',
    'npx vitest',
    'npx vitest run',
    'jest',
    'jest --watch',
    'npx jest',
    'pytest',
    'pytest tests/',
    'cargo test',
    'cargo watch',
    'go test',
    'go test ./...',
  ])('matches test runner command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'docker logs',
    'docker compose logs',
    'docker-compose logs',
  ])('matches Docker log command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'nodemon',
    'nodemon server.js',
    'air',
    'air -c .air.toml',
    'cargo watch',
    'watchexec',
    'watchexec npm test',
  ])('matches file-watcher command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'eslint',
    'eslint src/',
    'npx eslint .',
    'prettier',
    'prettier --check .',
    'npx prettier --write .',
    'ruff',
    'ruff check .',
    'clippy',
    'cargo clippy',
  ])('matches linter/formatter command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'git status',
    'git log',
    'ls',
    'ls -la',
    'echo hello',
    'cat package.json',
    'rg pattern src/',
    'node index.js',
    'npm install',
    'npm test',
  ])('does NOT match non-monitoring command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('returns a hint string containing --grep or --tail', () => {
    const hint = getMonitoringRecallHint('gh run watch')
    expect(hint).toMatch(/--grep|--tail/)
  })

  it('hint for pytest contains --grep', () => {
    const hint = getMonitoringRecallHint('pytest tests/')
    expect(hint).toContain('--grep')
  })

  it('hint for docker logs contains --tail', () => {
    const hint = getMonitoringRecallHint('docker logs container')
    expect(hint).toContain('--tail')
  })

  it('returns null for empty string', () => {
    expect(getMonitoringRecallHint('')).toBeNull()
  })

  it('handles leading whitespace in command', () => {
    expect(getMonitoringRecallHint('  pytest tests/')).not.toBeNull()
  })
})
