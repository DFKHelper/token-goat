/**
 * End-to-end regression for `token-goat trace --bodies` (feature-queue #314): resolving each
 * traceback frame's file:line to its enclosing symbol and inlining the body.
 *
 * Drives the REAL registered command function (`cmdTrace`, exported from text_commands.ts and
 * the exact function cli.ts's `trace` command wires up via `guard(() => cmdTrace(src, opts))`)
 * against a real, unmocked index built with `indexFileSync` (parser.ts) -- the same pipeline
 * `read_commands_stale_self_heal_e2e.test.ts` uses for its real-DB, no-injected-callback
 * coverage. This is deliberately NOT a test of resolveFrameSymbol/formatFrameBody in isolation:
 * calling cmdTrace itself is what proves the CLI's actual default path (querySymbols +
 * enclosingSymbol from graph_commands.ts, resolveBody from read_commands.ts) resolves and
 * formats bodies correctly, matching this codebase's "test the real registered path" discipline.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { cmdTrace } from '../src/text_commands.js'

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    fn()
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

let root: string
let origCwd: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-trace-bodies-'))
  origCwd = process.cwd()
  process.chdir(root)
})

afterEach(() => {
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
})

function writeTraceback(lines: string[]): string {
  const file = join(root, 'tb.txt')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

describe('trace --bodies', () => {
  it('resolves and inlines the body for 2+ project frames, in order', () => {
    const modA = join(root, 'mod_a9k.py')
    const modB = join(root, 'mod_b9k.py')
    writeFileSync(modA, 'def helperA9k():\n    x = 1\n    return x\n')
    writeFileSync(modB, 'def helperB9k():\n    y = 2\n    return y\n')
    indexFileSync(normalizePath(modA))
    indexFileSync(normalizePath(modB))

    const tb = writeTraceback([
      'Traceback (most recent call last):',
      `  File "${modA}", line 3, in helperA9k`,
      '    return x',
      `  File "${modB}", line 3, in helperB9k`,
      '    return y',
      'ValueError: bad input',
    ])

    const out = captureStdout(() => cmdTrace(tb, { bodies: true }))

    expect(out).toContain('helperA9k')
    expect(out).toContain('helperB9k')
    expect(out).toContain('def helperA9k():')
    expect(out).toContain('def helperB9k():')

    // Order: frame A's body must appear before frame B's body, matching frame order.
    const idxA = out.indexOf('def helperA9k():')
    const idxB = out.indexOf('def helperB9k():')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(idxA)
  })

  it('degrades gracefully for an unindexed/nonexistent frame while every other frame still gets its body', () => {
    const modA = join(root, 'mod_c9k.py')
    writeFileSync(modA, 'def helperC9k():\n    x = 1\n    return x\n')
    indexFileSync(normalizePath(modA))

    const ghostFile = join(root, 'does_not_exist_9k.py')

    const tb = writeTraceback([
      'Traceback (most recent call last):',
      `  File "${ghostFile}", line 5, in ghost9k`,
      '    ghost_call()',
      `  File "${modA}", line 3, in helperC9k`,
      '    return x',
      'ValueError: bad input',
    ])

    const out = captureStdout(() => cmdTrace(tb, { bodies: true }))

    // The unresolvable frame must not crash the command and must degrade to a clear miss note,
    // mirroring `token-goat scope`'s own "No symbols enclosing line N in 'file'" miss wording
    // (graph_commands.ts's runScope).
    expect(out).toContain(`No symbols enclosing line 5 in '${ghostFile}'`)
    expect(out).not.toContain('def ghost_call')

    // Every other (resolvable) frame still gets its body.
    expect(out).toContain('def helperC9k():')
  })

  it('dedupes an identical frame (recursion): body shown once, referenced by name on the repeat', () => {
    const modA = join(root, 'mod_d9k.py')
    writeFileSync(modA, 'def recurse9k(n):\n    if n <= 0:\n        return 0\n    return recurse9k(n - 1)\n')
    indexFileSync(normalizePath(modA))

    const tb = writeTraceback([
      'Traceback (most recent call last):',
      `  File "${modA}", line 4, in recurse9k`,
      '    return recurse9k(n - 1)',
      `  File "${modA}", line 4, in recurse9k`,
      '    return recurse9k(n - 1)',
      'RecursionError: maximum recursion depth exceeded',
    ])

    const out = captureStdout(() => cmdTrace(tb, { bodies: true }))

    // The full body text ("def recurse9k(n):") must appear exactly once, not once per frame.
    const bodyOccurrences = out.split('def recurse9k(n):').length - 1
    expect(bodyOccurrences).toBe(1)
    expect(out).toContain('(same as above)')
  })

  it('omitting --bodies is byte-for-byte unchanged from the pre-existing behavior', () => {
    const modA = join(root, 'mod_e9k.py')
    writeFileSync(modA, 'def helperE9k():\n    x = 1\n    return x\n')
    indexFileSync(normalizePath(modA))

    const tb = writeTraceback([
      'Traceback (most recent call last):',
      `  File "${modA}", line 3, in helperE9k`,
      '    return x',
      'ValueError: bad input',
    ])

    const withoutFlagOmitted = captureStdout(() => cmdTrace(tb, {}))
    const withoutFlagExplicitFalse = captureStdout(() => cmdTrace(tb, { bodies: false }))

    expect(withoutFlagOmitted).toBe(withoutFlagExplicitFalse)
    expect(withoutFlagOmitted).not.toContain('# body:')
    expect(withoutFlagOmitted).not.toContain('def helperE9k():')
  })

  it('--bodies --json includes a body/bodySymbol field for a resolved frame and bodyDuplicateOf for a repeat', () => {
    const modA = join(root, 'mod_f9k.py')
    writeFileSync(modA, 'def helperF9k():\n    x = 1\n    return x\n')
    indexFileSync(normalizePath(modA))

    const tb = writeTraceback([
      'Traceback (most recent call last):',
      `  File "${modA}", line 3, in helperF9k`,
      '    return x',
      `  File "${modA}", line 3, in helperF9k`,
      '    return x',
      'ValueError: bad input',
    ])

    const out = captureStdout(() => cmdTrace(tb, { bodies: true, json: true }))
    const parsed = JSON.parse(out) as {
      tracebacks: Array<{
        frames: Array<{ file: string; body?: string; bodySymbol?: { name: string }; bodyDuplicateOf?: string }>
      }>
    }
    const frames = parsed.tracebacks[0]?.frames ?? []
    expect(frames.length).toBe(2)
    expect(frames[0]?.bodySymbol?.name).toBe('helperF9k')
    expect(frames[0]?.body).toContain('def helperF9k():')
    // Must point back at the exact first-occurrence symbol (file::name), not just be present --
    // a wrong/garbled reference would silently break any consumer trying to resolve it.
    expect(frames[1]?.bodyDuplicateOf).toBe(`${normalizePath(modA)}::helperF9k`)
    expect(frames[1]?.body).toBeUndefined()
  })
})
