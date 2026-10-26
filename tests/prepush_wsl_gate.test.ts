/** The WSL gate (.lefthook-scripts/wsl-gate.sh) in a sandbox repo: a changed non-ASCII path must match its glob, and a missing pattern file must run the suite instead of skipping it. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWindowsBash } from '../src/shell.js'

const GATE = path.join(process.cwd(), '.lefthook-scripts', 'wsl-gate.sh').replace(/\\/g, '/')
// Git Bash on Windows, never the WSL launcher that a bare bash resolves to there; null skips the suite where no bash exists
const BASH = process.platform === 'win32' ? resolveWindowsBash() : '/bin/bash'
let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** Pushes a commit that adds `changed` on top of one that adds `src/plain.ts`, and returns what the gate decided against the given pattern file text (null: no pattern file). */
function gate(changed: string, patterns: string | null): { run: string; reason: string } {
  dir = mkdtempSync(path.join(tmpdir(), 'tg-wslgate-'))
  const root = path.join(dir, 'repo')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  git(dir, 'init', '-q', 'repo')
  writeFileSync(path.join(root, 'src', 'plain.ts'), 'export {}\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
  const base = git(root, 'rev-parse', 'HEAD')
  mkdirSync(path.dirname(path.join(root, changed)), { recursive: true })
  writeFileSync(path.join(root, changed), 'export {}\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'two')
  const head = git(root, 'rev-parse', 'HEAD')
  const patternFile = path.join(dir, 'paths.txt')
  if (patterns !== null) writeFileSync(patternFile, patterns, 'utf8')
  const script = [
    `source '${GATE}'`,
    `wsl_decide 'refs/heads/x ${head} refs/heads/x ${base}' '${patternFile.replace(/\\/g, '/')}'`,
    'echo "RUN=$WSL_RUN"',
    'echo "REASON=$WSL_REASON"',
  ].join('\n')
  const out = execFileSync(BASH ?? 'bash', ['-c', script], { cwd: root, encoding: 'utf8', env: { ...process.env, TG_PREPUSH_WSL: '' } })
  return { run: /^RUN=(.*)$/m.exec(out)?.[1] ?? '', reason: /^REASON=(.*)$/m.exec(out)?.[1] ?? '' }
}

describe.skipIf(BASH === null)('wsl gate', () => {
  it('matches a changed path with non-ASCII characters against its glob', () => {
    // HAND-DERIVED: git quotes such a path as "src/\303\251.ts" unless the listing is NUL-separated.
    const r = gate('src/é.ts', 'src/é*\n')
    expect(r.run).toBe('1')
    expect(r.reason).toContain('é')
  })

  it('skips the suite when no glob matches', () => {
    expect(gate('src/other.ts', 'src/process_tree.ts\n').run).toBe('0')
  })

  it('runs the suite when the pattern file is missing', () => {
    const r = gate('src/other.ts', null)
    expect(r.run).toBe('1')
    expect(r.reason).toContain('missing or unreadable')
  })

  it('selects the WSL leg for a shared test helper under the real pattern file', () => {
    const real = readFileSync(path.join(process.cwd(), '.lefthook-scripts', 'wsl-paths.txt'), 'utf8')
    const r = gate('tests/helpers/bundle.ts', real)
    expect(r.run).toBe('1')
    expect(r.reason).toContain('tests/helpers/bundle.ts')
  })

  it('leaves a plain test file off the WSL leg under the real pattern file', () => {
    const real = readFileSync(path.join(process.cwd(), '.lefthook-scripts', 'wsl-paths.txt'), 'utf8')
    expect(gate('tests/plain_suite.test.ts', real).run).toBe('0')
  })
})
