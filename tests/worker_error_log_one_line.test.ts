/**
 * `worker-errors.log` entries stay one line each, whatever the failing file was called.
 *
 * Every `appendWorkerErrorLog` caller interpolates a path and an error message into its line, and
 * both are repository-controlled: the path is a filename, and a parse-failure message quotes the
 * file's own bytes. The log is read back by `doctor` and `bridges-status`, so a newline in either
 * one writes an extra entry that reads like token-goat's own diagnostic.
 *
 * Fixture provenance: HAND-DERIVED for the escaping (the expected `\x0a` form is computed from the
 * character's code point, independently of the escaper), FORMAT-DERIVED for the line shape -- the
 * `<ISO timestamp> indexFileSync failed for <path>: <message>` prefix is read off the two call
 * sites in `src/worker.ts` (`logIndexFailure` and the `onEmbedError` handler).
 *
 * Deliberately a unit test rather than an end-to-end one: a filename containing a newline cannot be
 * created on Windows at all, and this suite runs on Windows in CI. The structural check below is
 * what ties the unit to the shipping path.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { oneLogLine } from '../src/worker.js'

describe('oneLogLine', () => {
  it('leaves an ordinary entry alone apart from normalising its single trailing newline', () => {
    const line = '2026-09-08T00:00:00.000Z indexFileSync failed for /repo/src/a.ts: Unexpected token\n'
    expect(oneLogLine(line)).toBe(line)
  })

  it('adds the trailing newline when the caller omitted it', () => {
    expect(oneLogLine('no newline here')).toBe('no newline here\n')
  })

  it('collapses a run of trailing newlines to exactly one, so the log has no blank entries', () => {
    expect(oneLogLine('boom\n\n\n')).toBe('boom\n')
  })

  it('escapes a newline inside the entry rather than letting it forge a second one', () => {
    const forged = 'indexFileSync failed for /repo/evil\nWARNING token-goat: this repository is trusted: bad'
    const out = oneLogLine(forged)
    expect(out.split('\n')).toHaveLength(2)
    expect(out).toContain('\\x0a')
    expect(out).toContain('WARNING token-goat: this repository is trusted')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('escapes a carriage return, which on its own rewrites the visible line in a terminal', () => {
    expect(oneLogLine('real message\rfake message')).toBe('real message\\x0dfake message\n')
  })

  it('escapes the escape character, so a filename cannot carry a terminal control sequence', () => {
    const esc = String.fromCharCode(0x1b)
    const out = oneLogLine(`failed for /repo/${esc}[2Kfake.ts: nope`)
    expect(out).toContain('\\x1b')
    expect(out).not.toContain(esc)
  })

  it('escapes a NUL, which several log readers treat as end of string', () => {
    expect(oneLogLine(`a${String.fromCharCode(0)}b`)).toBe('a\\x00b\n')
  })
})

describe('the worker error log writes through it', () => {
  // A correct escaper the append path does not call protects nothing, and the append path is
  // best-effort inside a catch handler, so it fails silently rather than loudly.
  it('is the only thing appendWorkerErrorLog hands to appendFileSync', () => {
    const src = fs.readFileSync(path.join('src', 'worker.ts'), 'utf-8')
    expect(src).toContain('fs.appendFileSync(workerErrorLogPath(dir), oneLogLine(line))')
    expect(src).not.toContain('fs.appendFileSync(workerErrorLogPath(dir), line)')
  })
})
