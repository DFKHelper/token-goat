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

  it.each([
    'git diff HEAD',
    'git diff HEAD src/foo.ts',
    'git diff src/foo.ts',
    'git diff',
    'git diff --cached',
    'git diff --cached src/foo.ts',
  ])('matches git diff command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'git diff --stat',
    'git diff --stat HEAD',
    'git diff --stat HEAD src/',
  ])('does NOT match git diff --stat (small output) "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it.each([
    'npm run test',
    'npm run test --reporter=verbose',
    'npm run build',
    'npm run lint',
    'npm run typecheck',
    'npm run check',
    'npm run type-check',
    'npm run spec',
  ])('matches npm run script "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it('git diff hint contains --grep', () => {
    expect(getMonitoringRecallHint('git diff HEAD')).toContain('--grep')
  })

  it('npm run build hint contains --grep', () => {
    expect(getMonitoringRecallHint('npm run build')).toContain('--grep')
  })

  it.each([
    'codex',
    'codex --model gpt-4o prompt.md',
    'codex review --output result.md',
  ])('matches codex CLI command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'glm.sh prompt.txt',
    '~/.claude/bin/glm.sh prompt.txt',
    '.claude/bin/glm.sh /tmp/prompt.txt',
  ])('matches glm.sh AI CLI command "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it('codex hint contains --tail and --grep', () => {
    const hint = getMonitoringRecallHint('codex review.md')
    expect(hint).toContain('--tail')
    expect(hint).toContain('--grep')
  })

  it('glm.sh hint contains --tail and --grep', () => {
    const hint = getMonitoringRecallHint('~/.claude/bin/glm.sh prompt.txt')
    expect(hint).toContain('--tail')
    expect(hint).toContain('--grep')
  })

  it.each([
    'cat Foo.java',
    'cat src/main/java/SomeService.java',
    'cat Auth.py',
    'cat handler.ts',
    'cat main.go',
    'cat server.rs',
    'cat Component.tsx',
  ])('matches cat of a single source file "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it.each([
    'cat package.json',
    'cat README.md',
    'cat .env',
    'cat file.txt',
    'cat file1.java file2.java',
  ])('does NOT match cat of non-source or multi-file "%s"', (cmd) => {
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('cat source file hint contains --tail', () => {
    const hint = getMonitoringRecallHint('cat Foo.java')
    expect(hint).toContain('--tail')
  })

  // Multiline PowerShell -Command blocks with read-only system queries
  it('matches multiline PS -Command block with Get-PSDrive and Get-CimInstance', () => {
    const cmd = [
      'powershell -NoProfile -Command "',
      '# Disk usage',
      'Get-PSDrive C | Select-Object @{N=\'Used_GB\';E={[math]::Round($_.Used/1GB,1)}}',
      '$os = Get-CimInstance Win32_OperatingSystem',
      '[PSCustomObject]@{ Total_GB = [math]::Round($os.TotalVisibleMemorySize/1MB,1) } | Format-List',
      '"',
    ].join('\n')
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
    expect(getMonitoringRecallHint(cmd)).toContain('--tail')
  })

  it('matches multiline PS -Command block with Get-Process and Write-Host', () => {
    const cmd = [
      'powershell -NoProfile -Command "',
      'Write-Host "=== CPU ===" -ForegroundColor Cyan',
      'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,CPU | Format-Table',
      '"',
    ].join('\n')
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })

  it('does NOT match multiline PS -Command block containing Remove- (destructive)', () => {
    const cmd = [
      'powershell -NoProfile -Command "',
      'Get-Process EoAExperiences',
      'Remove-Item $tempPath -Recurse -Force',
      '"',
    ].join('\n')
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('does NOT match multiline PS -Command block containing Stop-Process (destructive)', () => {
    const cmd = [
      'powershell -NoProfile -Command "',
      '$p = Get-Process EoAExperiences',
      'Stop-Process -Id $p.Id -Force',
      '"',
    ].join('\n')
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('does NOT match multiline PS -Command block without Get-* monitoring cmdlets', () => {
    const cmd = [
      'powershell -NoProfile -Command "',
      'Write-Host "Hello"',
      '$x = 1 + 1',
      '"',
    ].join('\n')
    expect(getMonitoringRecallHint(cmd)).toBeNull()
  })

  it('does NOT reclassify the single-line PS form via isPsMultilineSystemQuery (already handled by MONITORING_COMMAND_PATTERNS)', () => {
    // Single-line form should match via existing pattern, not fall through to multiline check
    const cmd = 'powershell -NoProfile -Command "Get-Process | Select-Object Name, CPU"'
    expect(getMonitoringRecallHint(cmd)).not.toBeNull()
  })
})
