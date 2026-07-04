/**
 * Regression tests for the todo / trace / logfold / lockdeps / note / hot / recent / ignores
 * CLI commands. Every test drives the REAL registered command via the built bundle so the
 * injected-seam trap cannot hide a broken default path.
 *
 * Mutation-verify targets (three non-trivial helpers):
 *   1. logfold fold counter — break normalizeVolatile so near-identical lines do NOT collapse;
 *      the (xN) assertion fails; restore from scratchpad backup confirms recovery.
 *   2. hot cross-file aggregation — break += to last-wins; multi-session total test fails; restore.
 *   3. todo string-literal exclusion — break isInsideStringLiteral; a quoted TODO appears; restore.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE, ROOT } from './helpers/bundle.js'

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

let tmpDir: string

function run(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts.cwd ?? tmpDir,
    encoding: 'utf8',
    timeout: 30000,
    env: opts.env ?? process.env,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function isolatedEnv(base: string): NodeJS.ProcessEnv {
  return { ...process.env, LOCALAPPDATA: base, XDG_DATA_HOME: base, TOKEN_GOAT_HOME: base }
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-text-cmds-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── todo ────────────────────────────────────────────────────────────────────

describe('todo command', () => {
  it('finds TODO and FIXME markers in a source file', () => {
    const src = path.join(tmpDir, 'markers.ts')
    fs.writeFileSync(src, 'const x = 1 // TODO: fix this\nfunction f() {} // FIXME: broken\n', 'utf8')
    const r = run(['todo', src])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('TODO')
    expect(r.stdout).toContain('FIXME')
  })

  it('excludes TODO markers inside string literals (fail-on-buggy: breaks when isInsideStringLiteral is disabled)', () => {
    const src = path.join(tmpDir, 'string_literal.ts')
    fs.writeFileSync(src, 'const msg = "TODO: this is in a string"\n', 'utf8')
    const r = run(['todo', src])
    expect(r.status, r.stderr).toBe(0)
    // A TODO inside a double-quoted string must NOT appear as a marker item (file:line  TODO format).
    expect(r.stdout).not.toMatch(/:\d+\s+TODO/)
  })

  it('does not misclassify a comment after a string ending in an escaped backslash as inside the string (fail-on-buggy: single-char lookbehind miscounts escaped-backslash-then-quote)', () => {
    const src = path.join(tmpDir, 'escaped_backslash.ts')
    fs.writeFileSync(src, 'const p = "path\\\\" // TODO: fix escaping\n', 'utf8')
    const r = run(['todo', src])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/:\d+\s+TODO/)
  })

  it('--kinds limits which markers are reported', () => {
    const src = path.join(tmpDir, 'kinds.ts')
    fs.writeFileSync(src, '// TODO: a\n// FIXME: b\n// HACK: c\n', 'utf8')
    const r = run(['todo', src, '--kinds', 'HACK'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('HACK')
    expect(r.stdout).not.toContain('TODO')
    expect(r.stdout).not.toContain('FIXME')
  })

  it('--json emits parseable structured output', () => {
    const src = path.join(tmpDir, 'json_out.ts')
    fs.writeFileSync(src, '// TODO: write tests\n// FIXME: handle error\n', 'utf8')
    const r = run(['todo', src, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { items: Array<{ kind: string; text: string }> }
    expect(parsed.items.length).toBe(2)
    const kinds = parsed.items.map((i) => i.kind)
    expect(kinds).toContain('TODO')
    expect(kinds).toContain('FIXME')
  })

  it('--group kind groups output by marker type', () => {
    const src = path.join(tmpDir, 'group.ts')
    fs.writeFileSync(src, '// TODO: a\n// FIXME: b\n', 'utf8')
    const r = run(['todo', src, '--group', 'kind'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('[TODO]')
    expect(r.stdout).toContain('[FIXME]')
  })

  it('treats a --kinds value with regex-special characters as a literal marker, not a regex pattern (regression: unescaped --kinds crashed cmdTodo with "Invalid regular expression")', () => {
    const src = path.join(tmpDir, 'regex_kinds.ts')
    fs.writeFileSync(src, '// TODO: a\n', 'utf8')
    const r = run(['todo', src, '--kinds', '('])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('Invalid regular expression')
    expect(r.stdout).toContain('No TODO markers found.')
  })
})

// ── trace ───────────────────────────────────────────────────────────────────

const SAMPLE_TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "main.py", line 3, in run',
  '    result = helper()',
  '  File "/usr/lib/python3/site-packages/pkg/util.py", line 10, in util_fn',
  '    pass',
  'ValueError: bad input',
].join('\n')

describe('trace command', () => {
  it('filters stdlib/site-packages frames and keeps project frames', () => {
    const r = run(['trace'], { input: SAMPLE_TRACEBACK, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('main.py')
    expect(r.stdout).not.toContain('site-packages')
  })

  it('preserves the exception line', () => {
    const r = run(['trace'], { input: SAMPLE_TRACEBACK, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('ValueError: bad input')
  })

  it('emits a stderr note and exits 0 when no traceback is present', () => {
    const r = run(['trace'], { input: 'no traceback here\n', cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('no traceback found')
  })

  it('--json emits parseable structured output', () => {
    const r = run(['trace', '--json'], { input: SAMPLE_TRACEBACK, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: unknown[]; exception: string }> }
    expect(parsed.tracebacks.length).toBeGreaterThan(0)
    expect(parsed.tracebacks[0]?.exception).toContain('ValueError')
  })

  it('--keep N limits to last N project frames', () => {
    const multi = [
      'Traceback (most recent call last):',
      '  File "a.py", line 1, in fa',
      '    x()',
      '  File "b.py", line 2, in fb',
      '    y()',
      'RuntimeError: oops',
    ].join('\n')
    const r = run(['trace', '--keep', '1', '--json'], { input: multi, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: unknown[] }> }
    expect(parsed.tracebacks[0]?.frames.length).toBe(1)
  })

  it('does not drop a second traceback whose frames run to EOF with no exception line (fail-on-buggy: trailing-frames flush is gated on the global blocks array, not scoped per block)', () => {
    const multi = [
      'Traceback (most recent call last):',
      '  File "a.py", line 1, in fa',
      '    x()',
      'ValueError: first error',
      'Traceback (most recent call last):',
      '  File "b.py", line 2, in fb',
      '    y()',
    ].join('\n')
    const r = run(['trace', '--json'], { input: multi, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }>; exception: string }> }
    expect(parsed.tracebacks.length).toBe(2)
    expect(parsed.tracebacks[0]?.exception).toContain('ValueError')
    expect(parsed.tracebacks[1]?.frames.length).toBe(1)
    expect(parsed.tracebacks[1]?.frames[0]?.file).toBe('b.py')
  })

  it('does not leak a following frame header into a preceding frame\'s context when two "File" lines are consecutive (regression: a frame with no printed source line stole the next frame\'s header text as its own context)', () => {
    const multi = [
      'Traceback (most recent call last):',
      '  File "a.py", line 1, in fa',
      '  File "b.py", line 2, in fb',
      '    do_something()',
      'ValueError: oops',
    ].join('\n')
    const r = run(['trace', '--json'], { input: multi, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      tracebacks: Array<{ frames: Array<{ file: string; context?: string }> }>
    }
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames[0]?.file).toBe('a.py')
    expect(frames[0]?.context).toBe('')
    expect(frames[1]?.file).toBe('b.py')
    expect(frames[1]?.context).toBe('do_something()')
  })
})

// ── logfold ─────────────────────────────────────────────────────────────────

describe('logfold command', () => {
  it('drops npm-summary lines via FILTERS', () => {
    const input = 'added 5 packages in 1s\nhello world\n'
    const r = run(['logfold'], { input })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toContain('added 5 packages')
    expect(r.stdout).toContain('hello world')
  })

  it('folds consecutive identical lines with (xN) count (fail-on-buggy: breaks when normalizeVolatile is neutralized)', () => {
    // Two lines that differ only in a timestamp — normalize should make them identical, so they fold.
    const input = '[12:00:01] connection hit\n[12:00:02] connection hit\n'
    const r = run(['logfold'], { input })
    expect(r.status, r.stderr).toBe(0)
    // After normalizing timestamps both lines become '[HH:MM:SS] connection hit', so the fold must produce a single line with (x2).
    expect(r.stdout).toMatch(/\(x2\)/)
  })

  it('does NOT fold when --no-normalize is set and lines differ only in timestamp', () => {
    const input = '[12:00:01] connection hit\n[12:00:02] connection hit\n'
    const r = run(['logfold', '--no-normalize'], { input })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/\(x2\)/)
  })

  it('--tail N restricts input to last N lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const r = run(['logfold', '--tail', '3'], { input: lines })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('line 9')
    expect(r.stdout).not.toContain('line 0')
  })

  it('--json emits parseable structured output', () => {
    const input = 'hello\nhello\n'
    const r = run(['logfold', '--json'], { input })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { lines: Array<{ text: string; count: number }> }
    expect(parsed.lines.length).toBeGreaterThan(0)
    const folded = parsed.lines.find((l) => l.count > 1)
    expect(folded).toBeDefined()
  })

  it('reads from a file when a src path is given', () => {
    const src = path.join(tmpDir, 'log.txt')
    fs.writeFileSync(src, 'alpha\nbeta\n', 'utf8')
    const r = run(['logfold', src])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('alpha')
  })
})

// ── lockdeps ─────────────────────────────────────────────────────────────────

describe('lockdeps command', () => {
  it('parses package-lock.json and lists packages', () => {
    const r = run(['lockdeps', path.join(ROOT, 'package-lock.json')])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('commander')
    expect(r.stdout).toContain('package-lock.json')
  })

  it('auto-detects package-lock.json in a directory', () => {
    const r = run(['lockdeps', ROOT])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('commander')
  })

  it('--json emits parseable structured output', () => {
    const r = run(['lockdeps', path.join(ROOT, 'package-lock.json'), '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { format: string; total: number; deps: unknown[] }
    expect(parsed.format).toBe('npm')
    expect(parsed.total).toBeGreaterThan(0)
    expect(parsed.deps.length).toBe(parsed.total)
  })

  it('parses a requirements.txt lockfile', () => {
    const req = path.join(tmpDir, 'requirements.txt')
    fs.writeFileSync(req, 'requests==2.31.0\nnumpy>=1.24.0\n', 'utf8')
    const r = run(['lockdeps', req])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('requests')
    expect(r.stdout).toContain('numpy')
  })

  it('parses an npm v1 lockfile (nested dependencies tree, no packages map) (regression: v1 lockfiles reported "Total: 0 packages" because only the v2/v3 packages map was read)', () => {
    const v1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-v1-lock-'))
    const lockPath = path.join(v1Dir, 'package-lock.json')
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        name: 'v1-fixture',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          foo: { version: '1.0.0', dependencies: { bar: { version: '2.0.0' } } },
          baz: { version: '3.0.0', dev: true },
        },
      }),
      'utf8',
    )
    const r = run(['lockdeps', lockPath, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      format: string
      total: number
      deps: Array<{ name: string; version: string; kind: string }>
    }
    expect(parsed.format).toBe('npm')
    expect(parsed.total).toBe(3)
    expect(parsed.deps).toContainEqual({ name: 'foo', version: '1.0.0', kind: 'direct' })
    expect(parsed.deps).toContainEqual({ name: 'bar', version: '2.0.0', kind: 'transitive' })
    expect(parsed.deps).toContainEqual({ name: 'baz', version: '3.0.0', kind: 'direct' })
    fs.rmSync(v1Dir, { recursive: true, force: true })
  })

  it('errors when no lockfile is found', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nolockfile-'))
    const r = run(['lockdeps', emptyDir])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('No lockfile found')
    fs.rmdirSync(emptyDir)
  })
})

// ── note ─────────────────────────────────────────────────────────────────────

describe('note command', () => {
  let noteEnv: NodeJS.ProcessEnv
  let noteData: string

  beforeAll(() => {
    noteData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-note-'))
    noteEnv = isolatedEnv(noteData)
  })

  afterAll(() => {
    fs.rmSync(noteData, { recursive: true, force: true })
  })

  it('set then get round-trips a value', () => {
    const rSet = run(['note', 'set', 'greeting', 'hello'], { env: noteEnv, cwd: ROOT })
    expect(rSet.status, rSet.stderr).toBe(0)
    const rGet = run(['note', 'get', 'greeting'], { env: noteEnv, cwd: ROOT })
    expect(rGet.status, rGet.stderr).toBe(0)
    expect(rGet.stdout.trim()).toBe('hello')
  })

  it('list shows all stored keys', () => {
    run(['note', 'set', 'k1', 'v1'], { env: noteEnv, cwd: ROOT })
    run(['note', 'set', 'k2', 'v2'], { env: noteEnv, cwd: ROOT })
    const r = run(['note', 'list'], { env: noteEnv, cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('k1')
    expect(r.stdout).toContain('k2')
  })

  it('list --json emits parseable structured output', () => {
    const r = run(['note', 'list', '--json'], { env: noteEnv, cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as Record<string, string>
    expect(typeof parsed).toBe('object')
  })

  it('unset removes a key', () => {
    run(['note', 'set', 'to-remove', 'bye'], { env: noteEnv, cwd: ROOT })
    const rUnset = run(['note', 'unset', 'to-remove'], { env: noteEnv, cwd: ROOT })
    expect(rUnset.status, rUnset.stderr).toBe(0)
    const rGet = run(['note', 'get', 'to-remove'], { env: noteEnv, cwd: ROOT })
    expect(rGet.status).toBe(1)
  })

  it('clear removes all keys', () => {
    run(['note', 'set', 'tempkey', 'tempval'], { env: noteEnv, cwd: ROOT })
    const rClear = run(['note', 'clear'], { env: noteEnv, cwd: ROOT })
    expect(rClear.status, rClear.stderr).toBe(0)
    const rList = run(['note', 'list'], { env: noteEnv, cwd: ROOT })
    expect(rList.stdout).toContain('no notes')
  })

  it('exits 1 when no project root is found', () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-noproject-'))
    try {
      const r = run(['note', 'set', 'k', 'v'], { env: noteEnv, cwd: isolated })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('No project root')
    } finally {
      fs.rmdirSync(isolated)
    }
  })
})

// ── hot ──────────────────────────────────────────────────────────────────────

describe('hot command', () => {
  it('returns exit 0 with no session data and prints a notice', () => {
    const hotData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hot-empty-'))
    try {
      const r = run(['hot'], { env: isolatedEnv(hotData) })
      expect(r.status, r.stderr).toBe(0)
    } finally {
      fs.rmSync(hotData, { recursive: true, force: true })
    }
  })

  it('aggregates readCount across multiple session files (fail-on-buggy: breaks when += is replaced with last-wins)', () => {
    const hotData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hot-multi-'))
    try {
      const sessDir = path.join(hotData, 'sessions')
      fs.mkdirSync(sessDir, { recursive: true })
      const file = '/fake/project/src/auth.ts'
      // Session 1: readCount 3; Session 2: readCount 5 — total must be 8.
      fs.writeFileSync(
        path.join(sessDir, 'sess1.json'),
        JSON.stringify({ files: [{ path: file, readCount: 3, lastReadAt: 1, wasEdited: false, sizeBytes: 100 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }),
        'utf8',
      )
      fs.writeFileSync(
        path.join(sessDir, 'sess2.json'),
        JSON.stringify({ files: [{ path: file, readCount: 5, lastReadAt: 2, wasEdited: false, sizeBytes: 100 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }),
        'utf8',
      )
      const r = run(['hot', '--json'], { env: isolatedEnv(hotData) })
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as { entries: Array<{ path: string; readCount: number }> }
      const entry = parsed.entries.find((e) => e.path === file)
      expect(entry, 'entry for fake file').toBeDefined()
      expect(entry?.readCount, 'sum of readCounts across sessions').toBe(8)
    } finally {
      fs.rmSync(hotData, { recursive: true, force: true })
    }
  })

  it('--limit N caps the result set', () => {
    const hotData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hot-limit-'))
    try {
      const sessDir = path.join(hotData, 'sessions')
      fs.mkdirSync(sessDir, { recursive: true })
      const files = Array.from({ length: 10 }, (_, i) => ({
        path: `/fake/file${i}.ts`,
        readCount: i + 1,
        lastReadAt: i,
        wasEdited: false,
        sizeBytes: 10,
      }))
      fs.writeFileSync(
        path.join(sessDir, 'multi.json'),
        JSON.stringify({ files, hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }),
        'utf8',
      )
      const r = run(['hot', '--limit', '3', '--json'], { env: isolatedEnv(hotData) })
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as { entries: unknown[] }
      expect(parsed.entries.length).toBe(3)
    } finally {
      fs.rmSync(hotData, { recursive: true, force: true })
    }
  })
})

// ── recent ──────────────────────────────────────────────────────────────────

describe('recent command', () => {
  it('returns exit 0 and prints the header in a fresh process', () => {
    const r = run(['recent', '5'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('current session')
  })

  it('--json emits parseable structured output', () => {
    const r = run(['recent', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { entries: unknown[]; scope: string }
    expect(parsed.scope).toBe('current-session')
    expect(Array.isArray(parsed.entries)).toBe(true)
  })
})

// ── ignores ──────────────────────────────────────────────────────────────────

describe('ignores command', () => {
  it('reports walk mode and exits 0', () => {
    const r = run(['ignores'], { cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Walk mode')
  })

  it('--json emits parseable structured output with expected keys', () => {
    const r = run(['ignores', '--json'], { cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { walkMode: string; excludeTests: boolean; blockedRoots: string[]; nonGitBuiltins: string[] }
    expect(['git', 'non-git']).toContain(parsed.walkMode)
    expect(typeof parsed.excludeTests).toBe('boolean')
    expect(Array.isArray(parsed.blockedRoots)).toBe(true)
  })

  it('detects git mode for this repo', () => {
    const r = run(['ignores', '--json'], { cwd: ROOT })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { walkMode: string }
    expect(parsed.walkMode).toBe('git')
  })
})
