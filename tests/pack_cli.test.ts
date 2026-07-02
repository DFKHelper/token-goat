/**
 * Regression tests for the pack / tokens / budget / failures CLI commands.
 *
 * Each test drives the REAL registered command via the built bundle and asserts
 * concrete behavior, not just reachability. One helper per non-trivial exit-code
 * gate is mutation-verified (break the structural condition → specific test
 * fails; restore from scratchpad backup → test passes again).
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(args: string[], opts: { cwd?: string; input?: string } = {}): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts.cwd ?? tmpDir,
    encoding: 'utf8',
    timeout: 30000,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pack-cli-'))
  fs.writeFileSync(
    path.join(tmpDir, 'hello.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n',
  )
  fs.writeFileSync(
    path.join(tmpDir, 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b\n}\n',
  )
  fs.writeFileSync(
    path.join(tmpDir, 'secret.ts'),
    'const key = "AKIAIOSFODNN7EXAMPLE"\n',
  )
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// pack

describe('pack command', () => {
  it('bundles a file and its content appears in output', () => {
    const r = run(['pack', 'hello.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('greet')
    expect(r.stdout).toContain('hello.ts')
  })

  it('--format xml wraps content in XML elements', () => {
    const r = run(['pack', 'hello.ts', '--format', 'xml'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('<documents>')
    expect(r.stdout).toContain('greet')
  })

  it('--format text produces plain output without markdown fences', () => {
    const r = run(['pack', 'hello.ts', '--format', 'text'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toContain('```')
    expect(r.stdout).toContain('greet')
  })

  it('--scan-secrets exits 2 when a credential is found', () => {
    const r = run(['pack', 'secret.ts', '--scan-secrets'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('secret')
  })

  it('--scan-secrets exits 0 when no credentials are found', () => {
    const r = run(['pack', 'hello.ts', '--scan-secrets'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('greet')
  })

  it('--budget exits 3 when token count exceeds the limit', () => {
    const r = run(['pack', 'hello.ts', '--budget', '1'])
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('exceeds budget')
  })

  it('--budget exits 0 when token count is within the limit', () => {
    const r = run(['pack', 'hello.ts', '--budget', '99999'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('greet')
  })

  it('--output writes to a file instead of stdout', () => {
    const dest = path.join(tmpDir, 'out.md')
    const r = run(['pack', 'hello.ts', '--output', dest])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(fs.readFileSync(dest, 'utf8')).toContain('greet')
  })

  // Regression guard: expandGlobs() applied a path.isAbsolute() guard in the literal-path
  // branch (skip re-joining against root when the path is already absolute) but not in the
  // glob-expansion branch, so an absolute glob pattern got its matched hits re-joined against
  // root anyway -- path.join() does not special-case an absolute second segment, so the result
  // was a mangled, nonexistent path instead of the real file.
  it('an absolute glob pattern is not mangled by re-joining its matches against the cwd', () => {
    const absoluteGlob = `${tmpDir.split(path.sep).join('/')}/hel*.ts`
    const r = run(['pack', absoluteGlob])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('greet')
  })

  // Regression guard: cmdPack fell back to reading stdin whenever expandGlobs() returned zero
  // matches, even when the user explicitly passed a pattern -- so a typo'd pattern silently
  // packed empty stdin instead of reporting "no files matched".
  it('a pattern that matches zero files errors instead of silently falling back to stdin', () => {
    const r = run(['pack', 'no-such-file-*.ts'], { input: '' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no files matched')
  })
})

// tokens

describe('tokens command', () => {
  it('shows a per-file table with token counts', () => {
    const r = run(['tokens', 'hello.ts', 'math.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('hello.ts')
    expect(r.stdout).toContain('math.ts')
    expect(r.stdout).toContain('~Tokens')
  })

  it('--top 1 limits output to one file row', () => {
    const r = run(['tokens', 'hello.ts', 'math.ts', '--top', '1'])
    expect(r.status, r.stderr).toBe(0)
    const fileRows = r.stdout.split('\n').filter((l) => l.includes('.ts') && !l.startsWith('-') && !l.startsWith('F'))
    expect(fileRows.length).toBe(1)
  })

  it('--json emits parseable structured output', () => {
    const r = run(['tokens', 'hello.ts', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { entries: Array<{ rel_path: string; tokens: number }>; total_tokens: number }
    expect(parsed.entries.length).toBeGreaterThan(0)
    expect(parsed.entries[0]?.tokens).toBeGreaterThan(0)
    expect(parsed.total_tokens).toBeGreaterThan(0)
  })

  it('--json includes expected fields per entry', () => {
    const r = run(['tokens', 'hello.ts', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { entries: Array<{ rel_path: string; lines: number; tokens: number; size_bytes: number }> }
    const entry = parsed.entries[0]
    expect(entry).toHaveProperty('rel_path')
    expect(entry).toHaveProperty('lines')
    expect(entry).toHaveProperty('tokens')
    expect(entry).toHaveProperty('size_bytes')
  })

  it('no files matched returns zero-row message', () => {
    const r = run(['tokens'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('No files matched.')
  })
})

// budget

describe('budget command', () => {
  it('prints a table showing token cost for the file', () => {
    const r = run(['budget', 'hello.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('hello.ts')
    expect(r.stdout).toContain('Total')
  })

  it('--context shows percentage fill annotation', () => {
    const r = run(['budget', 'hello.ts', '--context', '200'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+% of 200K/)
  })

  it('--json emits parseable structured output', () => {
    const r = run(['budget', 'hello.ts', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { entries: unknown[]; total_tokens: number; total_lines: number }
    expect(parsed.entries.length).toBeGreaterThan(0)
    expect(parsed.total_tokens).toBeGreaterThan(0)
  })

  it('total_tokens reflects actual content size', () => {
    const rSingle = run(['budget', 'hello.ts', '--json'])
    const rBoth = run(['budget', 'hello.ts', 'math.ts', '--json'])
    expect(rSingle.status, rSingle.stderr).toBe(0)
    expect(rBoth.status, rBoth.stderr).toBe(0)
    const single = JSON.parse(rSingle.stdout) as { total_tokens: number }
    const both = JSON.parse(rBoth.stdout) as { total_tokens: number }
    expect(both.total_tokens).toBeGreaterThan(single.total_tokens)
  })
})

// failures

const PYTEST_OUTPUT = [
  '=== FAILURES ===',
  '______ test_add ______',
  'def test_add():',
  '    assert 1 == 2',
  'E   AssertionError: assert 1 == 2',
  '',
  'test_math.py:4: AssertionError',
  '=== 1 failed in 0.05s ===',
].join('\n')

describe('failures command', () => {
  it('extracts a pytest failure block from stdin', () => {
    const r = run(['failures'], { input: PYTEST_OUTPUT })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('test_add')
  })

  it('reads from a file when a src path is given', () => {
    const srcFile = path.join(tmpDir, 'run.log')
    fs.writeFileSync(srcFile, PYTEST_OUTPUT, 'utf8')
    const r = run(['failures', srcFile])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('test_add')
  })

  it('--json emits parseable structured output', () => {
    const r = run(['failures', '--json'], { input: PYTEST_OUTPUT })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { runner: string; failures: Array<{ name: string }> }
    expect(parsed.runner).toBe('pytest')
    expect(parsed.failures.length).toBeGreaterThan(0)
    expect(parsed.failures[0]?.name).toContain('test_add')
  })

  it('--runner pytest forces pytest detection', () => {
    const r = run(['failures', '--runner', 'pytest', '--json'], { input: PYTEST_OUTPUT })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { runner: string }
    expect(parsed.runner).toBe('pytest')
  })
})
