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

import { normalizePath } from '../src/paths.js'
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

  it('does not drop a TODO whose comment line has an apostrophe before the marker (fail-on-buggy: single-quote parity misreads an apostrophe as an open string)', () => {
    const src = path.join(tmpDir, 'apostrophe.ts')
    fs.writeFileSync(src, "# can't stop now, TODO: fix the parser\n", 'utf8')
    const r = run(['todo', src])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/:\d+\s+TODO/)
  })

  it('still excludes a TODO inside a single-quoted-looking string when a real double-quoted string is open (guard: dropping single-quote gating must not reopen the double-quote exclusion)', () => {
    const src = path.join(tmpDir, 'still_excluded.ts')
    fs.writeFileSync(src, 'const msg = "it\'s a TODO: fake marker"\n', 'utf8')
    const r = run(['todo', src])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/:\d+\s+TODO/)
  })

  it('does not match a marker name as a prefix of a longer identifier/word (regression: the marker regex had a leading \\b but no trailing one, so "\\s*:?\\s*" matched zero-width and swallowed the rest of a longer word like "NOTEBOOK" or "TODOLIST" into the captured text)', () => {
    const src = path.join(tmpDir, 'prefix_word.ts')
    fs.writeFileSync(
      src,
      '// NOTEBOOK: this is just a variable name comment, not a marker\nconst TODOLIST = ["a", "b"]\nfunction HACKATHON() { return 1 }\n',
      'utf8',
    )
    const r = run(['todo', src, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { items: Array<{ kind: string }> }
    expect(parsed.items).toEqual([])
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

  // Regression: a non-numeric or negative --keep value fell through Number.parseInt's NaN
  // (NaN > 0 is false) or the sign check, so the `keepN > 0` guard silently disabled trimming
  // instead of erroring, printing every frame unbounded.
  it('--keep abc errors instead of silently printing every frame', () => {
    const multi = [
      'Traceback (most recent call last):',
      '  File "a.py", line 1, in fa',
      '    x()',
      'RuntimeError: oops',
    ].join('\n')
    const r = run(['trace', '--keep', 'abc'], { input: multi, cwd: tmpDir })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--keep')
  })

  it('--keep -5 errors instead of silently printing every frame', () => {
    const multi = [
      'Traceback (most recent call last):',
      '  File "a.py", line 1, in fa',
      '    x()',
      'RuntimeError: oops',
    ].join('\n')
    const r = run(['trace', '--keep', '-5'], { input: multi, cwd: tmpDir })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--keep')
  })

  it('does not swallow the real traceback that follows a zero-frame traceback header (regression: an adjacent "Traceback (...)" header was consumed as the empty block\'s exception text instead of starting a new block)', () => {
    const multi = [
      'Traceback (most recent call last):',
      'Traceback (most recent call last):',
      '  File "a.py", line 1, in fa',
      '    foo()',
      'ValueError: bad',
    ].join('\n')
    const r = run(['trace', '--json'], { input: multi, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }>; exception: string }> }
    const real = parsed.tracebacks.find((t) => t.exception.includes('ValueError'))
    expect(real).toBeDefined()
    expect(real?.frames[0]?.file).toBe('a.py')
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

  it('does not print a fabricated blank context line for a frame that had no source context in the original traceback (regression: cmdTrace\'s plain-text renderer checked f.context !== undefined, but parseTracebacks always assigns a string ("" for the no-context case), so the check was always true and printed a spurious blank indented line)', () => {
    const multi = [
      'Traceback (most recent call last):',
      '  File "<frozen importlib._bootstrap>", line 219, in _call_with_frames_removed',
      '  File "app.py", line 5, in <module>',
      '    main()',
      'ValueError: bad',
    ].join('\n')
    const r = run(['trace'], { input: multi, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toContain('_call_with_frames_removed\n    \n')
  })

  it.skipIf(process.platform !== 'win32')(
    'recognizes a WSL-style /mnt/<drive>/... frame path as a project frame when cwd is the native Windows path to the same directory (regression: isProjectFrame did a raw path.resolve + lowercase compare with no WSL/MSYS drive-letter rewrite, so an in-project WSL-mount-path frame was dropped)',
    () => {
      const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(tmpDir)
      if (!driveMatch) throw new Error(`tmpDir is not a drive-letter path: ${tmpDir}`)
      const wslFrame = `/mnt/${driveMatch[1]!.toLowerCase()}/${driveMatch[2]!.replace(/\\/g, '/')}/worker.py`
      const traceback = [
        'Traceback (most recent call last):',
        `  File "${wslFrame}", line 7, in run_worker`,
        '    do_work()',
        'RuntimeError: boom',
      ].join('\n')
      const r = run(['trace', '--json'], { input: traceback, cwd: tmpDir })
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }> }> }
      const frames = parsed.tracebacks[0]?.frames ?? []
      expect(frames.length).toBe(1)
      expect(frames[0]?.file).toBe(wslFrame)
    },
  )

  it(
    'recognizes a project frame whose path casing differs from cwd beyond the drive letter, on a case-insensitive filesystem (regression: isProjectFrame\'s WSL/MSYS fix (ff6e226c) switched from a full lowercase compare to canonicalize(), which only lowercases the drive letter via lowercaseDriveLetter, so a same-file frame differing in case elsewhere in the path was silently dropped)',
    () => {
      const upperFrame = `${tmpDir.toUpperCase().replace(/\\/g, '/')}/WORKER.PY`
      const traceback = [
        'Traceback (most recent call last):',
        `  File "${upperFrame}", line 7, in run_worker`,
        '    do_work()',
        'RuntimeError: boom',
      ].join('\n')
      const r = run(['trace', '--json'], {
        input: traceback,
        cwd: tmpDir,
        env: { ...process.env, TOKEN_GOAT_CASE_INSENSITIVE_FS: '1' },
      })
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }> }> }
      const frames = parsed.tracebacks[0]?.frames ?? []
      expect(frames.length).toBe(1)
      expect(frames[0]?.file).toBe(upperFrame)
    },
  )

  // ── Node.js grammar ──────────────────────────────────────────────────────

  const SAMPLE_NODE = [
    'Error: boom',
    '    at helper (main.js:12:34)',
    '    at Object.<anonymous> (node:internal/modules/cjs/loader:1105:14)',
  ].join('\n')

  it('parses a Node/V8 stack trace into the expected TraceBlock/TraceFrame shape', () => {
    // cmdTrace filters every frame through isProjectFrame before printing (node:internal/...
    // gets dropped -- covered separately below), so only the project-owned frame is expected
    // to survive here; the with-func parse itself is asserted directly.
    const r = run(['trace', '--json'], { input: SAMPLE_NODE, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number; func: string }>; exception: string }> }
    expect(parsed.tracebacks.length).toBe(1)
    expect(parsed.tracebacks[0]?.exception).toBe('Error: boom')
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.length).toBe(1)
    expect(frames[0]).toMatchObject({ file: 'main.js', lineNo: 12, func: 'helper' })
  })

  it('filters Node internal-protocol frames (node:internal/...) via isProjectFrame, keeping project frames', () => {
    const r = run(['trace'], { input: SAMPLE_NODE, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('main.js')
    expect(r.stdout).not.toContain('node:internal')
  })

  it('parses the anonymous Node frame form (no function name/parens)', () => {
    const anon = ['Error: anon boom', '    at main.js:3:1'].join('\n')
    const r = run(['trace', '--json'], { input: anon, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number; func: string }> }> }
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.length).toBe(1)
    expect(frames[0]).toMatchObject({ file: 'main.js', lineNo: 3, func: '' })
  })

  // ── Rust grammar ──────────────────────────────────────────────────────────

  const SAMPLE_RUST_NO_BACKTRACE = [
    "thread 'main' panicked at src/main.rs:10:5:",
    'called `Option::unwrap()` on a `None` value',
    'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  ].join('\n')

  const SAMPLE_RUST_WITH_BACKTRACE = [
    "thread 'main' panicked at src/main.rs:10:5:",
    'called `Option::unwrap()` on a `None` value',
    'stack backtrace:',
    '   0: rust_begin_unwind',
    '             at /rustc/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/library/std/src/panicking.rs:665:5',
    '   1: my_crate::helper',
    '             at src/helper.rs:20:9',
    '   2: my_crate::main',
    '             at src/main.rs:10:5',
    '   3: core::ops::function::FnOnce::call_once',
    '             at /rustc/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/library/core/src/ops/function.rs:250:5',
  ].join('\n')

  it('parses a Rust panic with no backtrace section into a single panic-site frame', () => {
    const r = run(['trace', '--json'], { input: SAMPLE_RUST_NO_BACKTRACE, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number }>; exception: string }> }
    expect(parsed.tracebacks.length).toBe(1)
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.length).toBe(1)
    expect(frames[0]).toMatchObject({ file: 'src/main.rs', lineNo: 10 })
    expect(parsed.tracebacks[0]?.exception).toBe('called `Option::unwrap()` on a `None` value')
  })

  it('prefers the parsed stack-backtrace frames over the single panic-site frame when RUST_BACKTRACE output is present (cmdTrace filters to project frames, so this proves the multi-frame backtrace -- not just the single panic-site frame -- was parsed: a fallback to the single frame would yield only 1 project frame here, not 2)', () => {
    const r = run(['trace', '--json'], { input: SAMPLE_RUST_WITH_BACKTRACE, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number; func: string }> }> }
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.length).toBe(2)
    expect(frames[0]).toMatchObject({ file: 'src/helper.rs', lineNo: 20, func: 'my_crate::helper' })
    expect(frames[1]).toMatchObject({ file: 'src/main.rs', lineNo: 10, func: 'my_crate::main' })
  })

  it('filters rustc-internal (/rustc/...) frames via isProjectFrame, keeping the project frame', () => {
    const r = run(['trace'], { input: SAMPLE_RUST_WITH_BACKTRACE, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('main.rs')
    expect(r.stdout).not.toContain('/rustc/')
  })

  it('skips a numbered backtrace frame with no `at <file>:<line>:<col>` continuation instead of aborting the whole scan (regression: a location-less frame -- normal for std/core frames compiled without debug info -- used to break the loop entirely and silently drop every deeper frame after it)', () => {
    const withLocationlessFrame = [
      "thread 'main' panicked at src/main.rs:10:5:",
      'boom',
      'stack backtrace:',
      '   0: rust_begin_unwind',
      '             at /rustc/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/library/std/src/panicking.rs:665:5',
      '   1: my_crate::helper',
      '             at src/helper.rs:20:9',
      // No `at ...` continuation for this frame -- a real, common shape for std/core frames.
      '   2: core::ops::function::FnOnce::call_once',
      '   3: my_crate::main',
      '             at src/main.rs:10:5',
    ].join('\n')
    const r = run(['trace', '--json'], { input: withLocationlessFrame, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number; func: string }> }> }
    const frames = parsed.tracebacks[0]?.frames ?? []
    // Pre-fix: the loop broke on frame 2's missing `at` line, so frame 3 (my_crate::main) was
    // silently dropped -- only frames 0 and 1 would be present here.
    expect(frames.map((f) => f.func)).toContain('my_crate::main')
    expect(frames.find((f) => f.func === 'my_crate::main')).toMatchObject({ file: 'src/main.rs', lineNo: 10 })
  })

  it('filters a Cargo-registry dependency frame via isProjectFrame', () => {
    const withDep = [
      "thread 'main' panicked at src/main.rs:10:5:",
      'boom',
      'stack backtrace:',
      '   0: some_dep::do_thing',
      '             at /home/user/.cargo/registry/src/index.crates.io/some_dep-1.0.0/src/lib.rs:5:1',
      '   1: my_crate::main',
      '             at ./src/main.rs:10:5',
    ].join('\n')
    const r = run(['trace'], { input: withDep, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('main.rs')
    expect(r.stdout).not.toContain('.cargo')
  })

  // ── JVM grammar ─────────────────────────────────────────────────────────

  const SAMPLE_JVM = [
    'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null',
    '\tat com.example.MyClass.doWork(MyClass.java:42)',
    '\tat com.example.External.doThing(/opt/vendor/External.java:5)',
    'Caused by: java.lang.IllegalStateException: root cause',
    '\tat com.example.Other.method(Other.java:5)',
    '\t... 3 more',
  ].join('\n')

  it('parses a JVM exception into the expected TraceBlock/TraceFrame shape, including a Caused by chain as its own block', () => {
    // No out-of-project frame here (that's covered separately below) -- cmdTrace filters every
    // frame through isProjectFrame before printing, so a frame this test doesn't want dropped
    // must itself resolve as project-owned.
    const shapeOnly = [
      'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null',
      '\tat com.example.MyClass.doWork(MyClass.java:42)',
      '\tat com.example.MyClass.main(MyClass.java:10)',
      'Caused by: java.lang.IllegalStateException: root cause',
      '\tat com.example.Other.method(Other.java:5)',
      '\t... 3 more',
    ].join('\n')
    const r = run(['trace', '--json'], { input: shapeOnly, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number; func: string }>; exception: string }> }
    expect(parsed.tracebacks.length).toBe(2)
    expect(parsed.tracebacks[0]?.exception).toContain('NullPointerException')
    const firstFrames = parsed.tracebacks[0]?.frames ?? []
    expect(firstFrames.length).toBe(2)
    expect(firstFrames[0]).toMatchObject({ file: 'MyClass.java', lineNo: 42, func: 'com.example.MyClass.doWork' })
    expect(parsed.tracebacks[1]?.exception).toContain('Caused by: java.lang.IllegalStateException')
    const secondFrames = parsed.tracebacks[1]?.frames ?? []
    expect(secondFrames.length).toBe(1)
    expect(secondFrames[0]).toMatchObject({ file: 'Other.java', lineNo: 5 })
  })

  it('filters a JVM frame with an absolute out-of-project file path via isProjectFrame, keeping the relative in-project frame', () => {
    const r = run(['trace'], { input: SAMPLE_JVM, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('MyClass.java')
    expect(r.stdout).not.toContain('External.java')
  })

  it('parses the Native Method/Unknown Source no-source-info JVM frame forms without crashing, and filters them out as non-project frames (regression: isProjectFrame treated the literal "Native Method"/"Unknown Source" marker text as a relative in-project path via canonicalize, wrongly keeping a frame with no real source location)', () => {
    const noSource = [
      'java.lang.RuntimeException: boom',
      '\tat java.base/java.lang.Thread.run(Native Method)',
      '\tat com.example.MyClass.run(MyClass.java:7)',
    ].join('\n')
    const r = run(['trace', '--json'], { input: noSource, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number }> }> }
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.some((f) => f.file === 'Native Method')).toBe(false)
    expect(frames.some((f) => f.file === 'MyClass.java' && f.lineNo === 7)).toBe(true)
  })

  // ── .NET grammar ────────────────────────────────────────────────────────

  const SAMPLE_DOTNET = [
    'Unhandled exception. System.NullReferenceException: Object reference not set to an instance of an object.',
    '   at MyApp.Program.DoWork() in Program.cs:line 42',
    '   at MyApp.Program.External() in /opt/vendor/External.cs:line 5',
  ].join('\n')

  it('parses a .NET exception into the expected TraceBlock/TraceFrame shape', () => {
    // No out-of-project frame here (that's covered separately below) -- cmdTrace filters every
    // frame through isProjectFrame before printing, so a frame this test doesn't want dropped
    // must itself resolve as project-owned.
    const shapeOnly = [
      'Unhandled exception. System.NullReferenceException: Object reference not set to an instance of an object.',
      '   at MyApp.Program.DoWork() in Program.cs:line 42',
      '   at MyApp.Program.Main(String[] args) in Program.cs:line 10',
    ].join('\n')
    const r = run(['trace', '--json'], { input: shapeOnly, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number; func: string }>; exception: string }> }
    expect(parsed.tracebacks.length).toBe(1)
    expect(parsed.tracebacks[0]?.exception).toContain('NullReferenceException')
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.length).toBe(2)
    expect(frames[0]).toMatchObject({ file: 'Program.cs', lineNo: 42, func: 'MyApp.Program.DoWork()' })
  })

  it('filters a .NET frame with an absolute out-of-project file path via isProjectFrame, keeping the relative in-project frame', () => {
    const r = run(['trace'], { input: SAMPLE_DOTNET, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Program.cs')
    expect(r.stdout).not.toContain('External.cs')
  })

  it('parses a bare .NET exception (no "Unhandled exception." prefix) and filters out a frame with no source location as a non-project frame (regression: isProjectFrame treated an empty framePath as cwd itself via canonicalize, wrongly keeping a frame with no real source location)', () => {
    const bare = [
      'System.InvalidOperationException: bad state',
      '   at MyApp.Program.DoWork() in Program.cs:line 9',
      '   at MyApp.Program.Main(String[] args)',
    ].join('\n')
    const r = run(['trace', '--json'], { input: bare, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string; lineNo: number; func: string }> }> }
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.length).toBe(1)
    expect(frames[0]).toMatchObject({ file: 'Program.cs', lineNo: 9, func: 'MyApp.Program.DoWork()' })
  })

  // ── mixed grammars in one input ────────────────────────────────────────

  it('parses both a Python traceback and a Node stack trace present in the same input (mixed CI log)', () => {
    const mixed = [SAMPLE_TRACEBACK, '', SAMPLE_NODE].join('\n')
    const r = run(['trace', '--json'], { input: mixed, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }>; exception: string }> }
    expect(parsed.tracebacks.length).toBe(2)
    expect(parsed.tracebacks[0]?.exception).toContain('ValueError')
    expect(parsed.tracebacks[0]?.frames.some((f) => f.file === 'main.py')).toBe(true)
    expect(parsed.tracebacks[1]?.exception).toBe('Error: boom')
    expect(parsed.tracebacks[1]?.frames.some((f) => f.file === 'main.js')).toBe(true)
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

  // Regression: a non-numeric or negative --tail value fell through Number.parseInt's NaN
  // (Number.isFinite(NaN) is false) or the sign check, so the guard silently skipped the
  // slice, printing every line unbounded instead of erroring.
  it('--tail abc errors instead of silently printing every line', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const r = run(['logfold', '--tail', 'abc'], { input: lines })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--tail')
  })

  it('--tail -5 errors instead of silently printing every line', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const r = run(['logfold', '--tail', '-5'], { input: lines })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('--tail')
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

  it('recovers the package name from a VCS #egg= fragment in requirements.txt instead of treating it as a comment (regression: stripping at the first "#" truncated "git+https://...#egg=name" URLs, silently dropping the real dependency and emitting a bogus "git" entry)', () => {
    const req = path.join(tmpDir, 'requirements.txt')
    fs.writeFileSync(
      req,
      'requests==2.31.0\ngit+https://github.com/psf/requests-oauthlib.git@v1.3.0#egg=requests-oauthlib\nnumpy>=1.24.0\n',
      'utf8',
    )
    const r = run(['lockdeps', req, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { deps: Array<{ name: string }> }
    const names = parsed.deps.map((d) => d.name)
    expect(names).toContain('requests-oauthlib')
    expect(names).not.toContain('git')
  })

  it('does not fabricate a dependency from a "#egg=" fragment mentioned inside a comment line (regression: the #104 VCS-fragment recovery ran unconditionally on every raw line, so a doc comment giving a VCS-install example was parsed as a real dependency)', () => {
    const req = path.join(tmpDir, 'requirements.txt')
    fs.writeFileSync(
      req,
      'requests==2.31.0\n# example: pip install git+https://github.com/psf/requests.git@main#egg=requests-old\n',
      'utf8',
    )
    const r = run(['lockdeps', req, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { deps: Array<{ name: string }> }
    const names = parsed.deps.map((d) => d.name)
    expect(names).toEqual(['requests'])
  })

  it('does not fabricate a dependency from a "#egg=" fragment mentioned inside a trailing inline comment on an ordinary pinned dependency (regression: the egg-fragment recovery matched "#egg=" anywhere in the raw line, not just when the line itself is a VCS spec, so a normal pin with a trailing comment mentioning "#egg=" had its real dependency silently dropped and replaced by a fabricated one parsed from the comment)', () => {
    const req = path.join(tmpDir, 'requirements.txt')
    fs.writeFileSync(
      req,
      'requests==2.31.0  # see git+https://github.com/example/fork.git#egg=requests-fork for internal patch\n',
      'utf8',
    )
    const r = run(['lockdeps', req, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed2 = JSON.parse(r.stdout) as { deps: Array<{ name: string; version: string }> }
    expect(parsed2.deps).toEqual([{ name: 'requests', version: '2.31.0', kind: 'unknown' }])
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

  it('parses npm v2/v3 lockfile with nested dependencies (regression: nested node_modules paths like node_modules/parent/node_modules/child were incorrectly parsed as parent/node_modules/child instead of child)', () => {
    const v2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-v2-lock-'))
    const lockPath = path.join(v2Dir, 'package-lock.json')
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        name: 'v2-fixture',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { dependencies: { parent: '1.0.0', direct: '2.0.0' } },
          'node_modules/parent': { version: '1.0.0' },
          'node_modules/parent/node_modules/child': { version: '1.5.0' },
          'node_modules/direct': { version: '2.0.0' },
          'node_modules/transitive': { version: '3.0.0' },
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
    expect(parsed.total).toBe(4)
    expect(parsed.deps).toContainEqual({ name: 'parent', version: '1.0.0', kind: 'direct' })
    expect(parsed.deps).toContainEqual({ name: 'child', version: '1.5.0', kind: 'transitive' })
    expect(parsed.deps).toContainEqual({ name: 'direct', version: '2.0.0', kind: 'direct' })
    expect(parsed.deps).toContainEqual({ name: 'transitive', version: '3.0.0', kind: 'transitive' })
    fs.rmSync(v2Dir, { recursive: true, force: true })
  })

  it('does not mislabel a nested transitive dependency as direct when it shares a name with a real top-level direct dependency (regression: kind was decided by allDirect.has(name) alone -- a bare name match -- so a deeper package.json entry like node_modules/some-lib/node_modules/semver, which is genuinely transitive, was labeled "direct" purely because the project also directly depends on a top-level semver at a different version)', () => {
    const nameCollisionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-name-collision-lock-'))
    const lockPath = path.join(nameCollisionDir, 'package-lock.json')
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        name: 'collision-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { semver: '^7.5.0' } },
          'node_modules/semver': { version: '7.5.0' },
          'node_modules/some-lib': { version: '1.0.0' },
          'node_modules/some-lib/node_modules/semver': { version: '5.7.1' },
        },
      }),
      'utf8',
    )
    const r = run(['lockdeps', lockPath, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      deps: Array<{ name: string; version: string; kind: string }>
    }
    expect(parsed.deps).toContainEqual({ name: 'semver', version: '7.5.0', kind: 'direct' })
    expect(parsed.deps).toContainEqual({ name: 'semver', version: '5.7.1', kind: 'transitive' })
    fs.rmSync(nameCollisionDir, { recursive: true, force: true })
  })

  it('reports "unknown" (not fabricated "direct") for Pipfile.lock entries, since default/develop list the full resolved set with no dependency-edge data to distinguish direct from transitive (regression: parsePipfileLock hardcoded kind: "direct" for every entry, unlike the sibling parsers with the same no-edge-data limitation -- parseTomlPackages/parseYarnLock/parseRequirementsTxt -- which all correctly report "unknown")', () => {
    const pipfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pipfile-lock-'))
    const lockPath = path.join(pipfileDir, 'Pipfile.lock')
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        _meta: {},
        default: { requests: { version: '==2.31.0' } },
        develop: { pytest: { version: '==7.4.0' } },
      }),
      'utf8',
    )
    const r = run(['lockdeps', lockPath, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      format: string
      deps: Array<{ name: string; version: string; kind: string }>
    }
    expect(parsed.format).toBe('pipfile')
    expect(parsed.deps).toContainEqual({ name: 'requests', version: '2.31.0', kind: 'unknown' })
    expect(parsed.deps).toContainEqual({ name: 'pytest', version: '7.4.0', kind: 'unknown' })
    fs.rmSync(pipfileDir, { recursive: true, force: true })
  })

  it('parses a pnpm-lock.yaml (lockfileVersion 9, workspace-style importers wrapper), distinguishing direct from transitive by matching both name AND resolved version against the root importer (regression: pnpm-lock.yaml was entirely unsupported -- absent from LOCK_PRIORITY and parseLockFile -- so "token-goat lockdeps" in any pnpm project failed with "No lockfile found", the same gap already fixed for npm/yarn/poetry/uv/Pipfile/Cargo)', () => {
    const pnpmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pnpm-lock-'))
    const lockPath = path.join(pnpmDir, 'pnpm-lock.yaml')
    fs.writeFileSync(
      lockPath,
      [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        '        specifier: ^4.17.21',
        '        version: 4.17.21',
        '    devDependencies:',
        '      typescript:',
        '        specifier: ^5.0.0',
        '        version: 5.0.0',
        '',
        'packages:',
        '',
        "  lodash@4.17.21:",
        "    resolution: {integrity: sha512-fake}",
        '',
        "  typescript@5.0.0:",
        "    resolution: {integrity: sha512-fake}",
        '',
        "  '@scope/transitive-dep@1.2.3':",
        "    resolution: {integrity: sha512-fake}",
        '',
      ].join('\n'),
      'utf8',
    )
    const r = run(['lockdeps', lockPath, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      format: string
      total: number
      deps: Array<{ name: string; version: string; kind: string }>
    }
    expect(parsed.format).toBe('pnpm')
    expect(parsed.total).toBe(3)
    expect(parsed.deps).toContainEqual({ name: 'lodash', version: '4.17.21', kind: 'direct' })
    expect(parsed.deps).toContainEqual({ name: 'typescript', version: '5.0.0', kind: 'direct' })
    expect(parsed.deps).toContainEqual({ name: '@scope/transitive-dep', version: '1.2.3', kind: 'transitive' })
    fs.rmSync(pnpmDir, { recursive: true, force: true })
  })

  it('parses a pre-workspace pnpm-lock.yaml (lockfileVersion < 9, no importers wrapper, packages keys prefixed with "/" and peer-dependency-suffixed) without mis-splitting the scoped/peer-suffixed package keys', () => {
    const pnpmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pnpm-lock-v6-'))
    const lockPath = path.join(pnpmDir, 'pnpm-lock.yaml')
    fs.writeFileSync(
      lockPath,
      [
        "lockfileVersion: '6.0'",
        '',
        'dependencies:',
        '  react-redux:',
        '    specifier: ^8.1.0',
        "    version: 8.1.0(react@18.2.0)",
        '',
        'packages:',
        '',
        "  /react-redux@8.1.0(react@18.2.0):",
        "    resolution: {integrity: sha512-fake}",
        '',
        "  /@babel/core@7.22.0:",
        "    resolution: {integrity: sha512-fake}",
        '',
      ].join('\n'),
      'utf8',
    )
    const r = run(['lockdeps', lockPath, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      format: string
      deps: Array<{ name: string; version: string; kind: string }>
    }
    expect(parsed.format).toBe('pnpm')
    expect(parsed.deps).toContainEqual({ name: 'react-redux', version: '8.1.0', kind: 'direct' })
    expect(parsed.deps).toContainEqual({ name: '@babel/core', version: '7.22.0', kind: 'transitive' })
    fs.rmSync(pnpmDir, { recursive: true, force: true })
  })

  it('errors when no lockfile is found', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nolockfile-'))
    const r = run(['lockdeps', emptyDir])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('No lockfile found')
    fs.rmdirSync(emptyDir)
  })

  it('honors an explicit lockfile argument over LOCK_PRIORITY when the directory also has a higher-priority lockfile (regression: findLockfile reduced an explicit file path to its containing directory and re-picked by LOCK_PRIORITY, silently discarding the caller\'s actual choice -- "lockdeps ./yarn.lock" in a dir that also had package-lock.json parsed package-lock.json instead)', () => {
    const mixedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mixed-lock-'))
    fs.writeFileSync(
      path.join(mixedDir, 'package-lock.json'),
      JSON.stringify({
        name: 'npm-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { dependencies: { 'npm-only-pkg': '1.0.0' } }, 'node_modules/npm-only-pkg': { version: '1.0.0' } },
      }),
      'utf8',
    )
    const yarnLockPath = path.join(mixedDir, 'yarn.lock')
    fs.writeFileSync(
      yarnLockPath,
      ['yarn-only-pkg@^1.0.0:', '  version "1.2.3"', '  resolved "https://example.com/yarn-only-pkg-1.2.3.tgz"', ''].join('\n'),
      'utf8',
    )

    const r = run(['lockdeps', yarnLockPath, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      format: string
      file: string
      deps: Array<{ name: string; version: string }>
    }
    expect(parsed.format).toBe('yarn')
    expect(parsed.deps).toContainEqual({ name: 'yarn-only-pkg', version: '1.2.3', kind: 'unknown' })
    expect(parsed.deps.some((d) => d.name === 'npm-only-pkg')).toBe(false)

    fs.rmSync(mixedDir, { recursive: true, force: true })
  })

  describe('--package (single-package query)', () => {
    function writeGraphFixture(dir: string): string {
      const lockPath = path.join(dir, 'package-lock.json')
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          name: 'graph-fixture',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { direct: '2.0.0', other: '1.0.0' } },
            'node_modules/direct': { version: '2.0.0', dependencies: { mid: '^1.0.0' } },
            'node_modules/mid': { version: '1.0.0', dependencies: { child: '^1.0.0' } },
            'node_modules/child': { version: '1.5.0' },
            'node_modules/other': { version: '1.0.0' },
          },
        }),
        'utf8',
      )
      return lockPath
    }

    it('returns a transitive package\'s version, direct deps, and reverse-lookup of which top-level deps pull it in', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lockdeps-pkg-'))
      const lockPath = writeGraphFixture(dir)
      const r = run(['lockdeps', lockPath, '--package', 'child', '--json'])
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as {
        package: string
        version: string
        kind: string
        graphAvailable: boolean
        dependsOn: string[]
        dependedOnBy: string[]
      }
      expect(parsed.package).toBe('child')
      expect(parsed.version).toBe('1.5.0')
      expect(parsed.kind).toBe('transitive')
      expect(parsed.graphAvailable).toBe(true)
      expect(parsed.dependsOn).toEqual([])
      expect(parsed.dependedOnBy).toEqual(['direct'])
      expect(parsed.dependedOnBy).not.toContain('other')
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('returns a direct package\'s own direct dependencies and excludes itself from the reverse lookup', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lockdeps-pkg-'))
      const lockPath = writeGraphFixture(dir)
      const r = run(['lockdeps', lockPath, '--package', 'direct', '--json'])
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as { package: string; kind: string; dependsOn: string[]; dependedOnBy: string[] }
      expect(parsed.package).toBe('direct')
      expect(parsed.kind).toBe('direct')
      expect(parsed.dependsOn).toEqual(['mid'])
      expect(parsed.dependedOnBy).toEqual([])
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('non-JSON output includes the package, version, depends-on, and depended-on-by sections', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lockdeps-pkg-'))
      const lockPath = writeGraphFixture(dir)
      const r = run(['lockdeps', lockPath, '--package', 'child'])
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('Package: child')
      expect(r.stdout).toContain('Version: 1.5.0')
      expect(r.stdout).toContain('Depends on (0):')
      expect(r.stdout).toContain('Depended on by direct/top-level deps (1):')
      expect(r.stdout).toContain('direct')
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('exits non-zero with a clear error, including a did-you-mean suggestion, when the package is not in the lockfile', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lockdeps-pkg-'))
      const lockPath = writeGraphFixture(dir)
      const r = run(['lockdeps', lockPath, '--package', 'chil'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("Package 'chil' not found")
      expect(r.stderr).toContain('did you mean')
      expect(r.stderr).toContain('child')
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('degrades gracefully for lockfile formats with no parsed edge data (requirements.txt): version/kind still resolve, graph fields report unavailable', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lockdeps-pkg-req-'))
      const req = path.join(dir, 'requirements.txt')
      fs.writeFileSync(req, 'requests==2.31.0\nnumpy>=1.24.0\n', 'utf8')
      const r = run(['lockdeps', req, '--package', 'requests', '--json'])
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as {
        package: string
        version: string
        graphAvailable: boolean
        dependsOn: string[]
        dependedOnBy: string[]
      }
      expect(parsed.package).toBe('requests')
      expect(parsed.version).toBe('2.31.0')
      expect(parsed.graphAvailable).toBe(false)
      expect(parsed.dependsOn).toEqual([])
      expect(parsed.dependedOnBy).toEqual([])
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('leaves the default full-dump behavior (no --package) completely unchanged', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lockdeps-pkg-'))
      const lockPath = writeGraphFixture(dir)
      const r = run(['lockdeps', lockPath, '--json'])
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as { format: string; total: number; deps: unknown[] }
      expect(parsed.format).toBe('npm')
      expect(parsed.total).toBe(4)
      expect(parsed.deps.length).toBe(4)
      fs.rmSync(dir, { recursive: true, force: true })
    })
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

  it('--project does not fold case on a case-sensitive filesystem (regression: cmdHot used a bare .toLowerCase() on both the project root and every candidate path instead of foldPath(), which is gated on isCaseInsensitiveFs()/TOKEN_GOAT_CASE_INSENSITIVE_FS -- so on a case-sensitive filesystem, a differently-cased sibling directory was wrongly treated as inside the project)', () => {
      const hotData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hot-case-'))
      const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hot-caseproj-'))
      try {
        fs.mkdirSync(path.join(projRoot, '.git'))
        const sessDir = path.join(hotData, 'sessions')
        fs.mkdirSync(sessDir, { recursive: true })
        // Recorded session paths are stored pre-normalized by the real hook path
        // (normalizePath in paths.ts), matching the format findProject's own
        // canonicalize()/foldPath() output uses -- reuse normalizePath itself for the fixture
        // rather than hand-rolling a slash-flip + drive-lowercase (that reimplementation
        // already caused a Windows-CI-only failure once before, see commit 442f42d3: a runner
        // whose %TEMP% is pinned to its 8.3 short form, e.g. GitHub's windows-latest
        // RUNNER~1, needs the same short-name expansion normalizePath performs, which a
        // hand-rolled version silently skips).
        const projRootNorm = normalizePath(projRoot)
        const realFile = `${projRootNorm}/real.ts`
        // Same path as projRoot but with its basename's case flipped -- a distinct directory on
        // a case-sensitive filesystem, and must NOT match under --project there.
        const upperRootNorm = `${projRootNorm.slice(0, projRootNorm.lastIndexOf('/'))}/${path.basename(projRootNorm).toUpperCase()}`
        const otherFile = `${upperRootNorm}/other-unrelated.ts`
        fs.writeFileSync(
          path.join(sessDir, 'sess1.json'),
          JSON.stringify({
            files: [
              { path: realFile, readCount: 3, lastReadAt: 1, wasEdited: false, sizeBytes: 100 },
              { path: otherFile, readCount: 9, lastReadAt: 1, wasEdited: false, sizeBytes: 100 },
            ],
            hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [],
          }),
          'utf8',
        )
        const r = run(['hot', '--project', '--json'], {
          cwd: projRoot,
          env: { ...isolatedEnv(hotData), TOKEN_GOAT_CASE_INSENSITIVE_FS: '0' },
        })
        expect(r.status, r.stderr).toBe(0)
        const parsed = JSON.parse(r.stdout) as { entries: Array<{ path: string; readCount: number }> }
        const paths = parsed.entries.map((e) => e.path)
        expect(paths).toContain(realFile)
        expect(paths).not.toContain(otherFile)
      } finally {
        fs.rmSync(hotData, { recursive: true, force: true })
        fs.rmSync(projRoot, { recursive: true, force: true })
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

  it('aggregates readCount for the same file recorded under different casings across sessions on a case-insensitive filesystem (regression: loadAllSessionReadCounts keyed its totals map on the raw path string, not foldPath(path) -- normalizePath only lowercases the drive letter, so the same physical file read with two different literal casings in separate sessions split into two map entries instead of merging, undercounting the true readCount and risking dropping a genuinely hot file out of a --limit-bounded result)', () => {
    const hotData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hot-casemix-'))
    try {
      const sessDir = path.join(hotData, 'sessions')
      fs.mkdirSync(sessDir, { recursive: true })
      const lower = '/fake/project/src/Auth.ts'
      const upper = '/fake/project/src/AUTH.ts'
      fs.writeFileSync(
        path.join(sessDir, 'sess1.json'),
        JSON.stringify({ files: [{ path: lower, readCount: 3, lastReadAt: 1, wasEdited: false, sizeBytes: 100 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }),
        'utf8',
      )
      fs.writeFileSync(
        path.join(sessDir, 'sess2.json'),
        JSON.stringify({ files: [{ path: upper, readCount: 5, lastReadAt: 2, wasEdited: false, sizeBytes: 100 }], hintsShown: [], webFetches: [], bashOutputs: [], curlDownloads: [] }),
        'utf8',
      )
      const r = run(['hot', '--json'], { env: { ...isolatedEnv(hotData), TOKEN_GOAT_CASE_INSENSITIVE_FS: '1' } })
      expect(r.status, r.stderr).toBe(0)
      const parsed = JSON.parse(r.stdout) as { entries: Array<{ path: string; readCount: number }> }
      expect(parsed.entries.length, 'must merge into one entry, not split across two casings').toBe(1)
      expect(parsed.entries[0]?.readCount, 'sum of readCounts across differently-cased sessions').toBe(8)
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

  // Regression: a zero, non-numeric, or negative --limit value fell through Number.parseInt's
  // NaN (NaN > 0 is false) or the sign check, so the `limit > 0` guard silently skipped the
  // slice, printing every entry unbounded instead of erroring or applying the limit.
  it('--limit 0/abc/-5 all error instead of silently printing every entry', () => {
    const hotData = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hot-badlimit-'))
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
      for (const bad of ['abc', '-5']) {
        const r = run(['hot', '--limit', bad], { env: isolatedEnv(hotData) })
        expect(r.status, `--limit ${bad}`).not.toBe(0)
        expect(r.stderr).toContain('--limit')
      }
      const zero = run(['hot', '--limit', '0', '--json'], { env: isolatedEnv(hotData) })
      expect(zero.status, zero.stderr).toBe(0)
      const parsedZero = JSON.parse(zero.stdout) as { entries: unknown[] }
      expect(parsedZero.entries.length).toBe(0)
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

  // Regression: a non-numeric or negative n argument fell through Number.parseInt's NaN
  // (NaN > 0 is false) or the sign check, so the `n > 0 ? n : 20` fallback silently defaulted
  // to printing (up to) every entry instead of erroring.
  it('recent abc errors instead of silently falling back to the default limit', () => {
    const r = run(['recent', 'abc'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('recent')
  })

  it('recent -5 errors instead of silently falling back to the default limit', () => {
    // `--` forces commander to treat "-5" as the positional n argument rather than an
    // unrecognized option flag, so this exercises requireNonNegativeInt's sign check.
    const r = run(['recent', '--', '-5'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('recent')
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

describe('isProjectFrame path boundary check', () => {
  it('does not match sibling directories with similar names (regression: path boundary bug with startsWith)', () => {
    // Bug: if project root is /tmp/abc, a frame from /tmp/abc-fork/file.py should NOT match
    // because startsWith("/tmp/abc") on "/tmp/abc-fork/file.py" returns true without boundary check.
    const sibling = tmpDir + '-fork'
    const traceback = [
      'Traceback (most recent call last):',
      `  File "${sibling}/src/something.py", line 1, in test`,
      '    result = helper()',
      'ValueError: bad input',
    ].join('\n')
    const r = run(['trace', '--json'], { input: traceback, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }> }> }
    // The fork path should NOT be treated as a project frame (0 frames)
    // If the bug exists, this will fail and show 1 frame instead of 0
    expect(parsed.tracebacks[0]?.frames.length).toBe(0)
  })

  it('still matches actual project subdirectories and exact project root', () => {
    // Real project frames should still be matched
    const traceback = [
      'Traceback (most recent call last):',
      `  File "${tmpDir}/src/something.py", line 1, in test`,
      '    result = helper()',
      `  File "${tmpDir}", line 2, in root`,
      '    run()',
      'ValueError: bad input',
    ].join('\n')
    const r = run(['trace', '--json'], { input: traceback, cwd: tmpDir })
    expect(r.status, r.stderr).toBe(0)
    const parsed = JSON.parse(r.stdout) as { tracebacks: Array<{ frames: Array<{ file: string }> }> }
    // Both the subdirectory and the exact root should be treated as project frames (2 frames)
    expect(parsed.tracebacks[0]?.frames.length).toBe(2)
  })
})
