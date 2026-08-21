/**
 * Guard: an R function must be indexed with the extent of its body, not just its first line.
 *
 * Every R function was recorded as a single-line symbol, so `read "analysis.R::compute_mean"`
 * answered with `compute_mean <- function(xs) {` and nothing else. That is the one thing a surgical
 * read exists to do, and it failed silently: the output is well-formed, names the right symbol, and
 * simply omits the body, so nothing downstream can tell a one-line function from a hundred-line one
 * whose body was dropped. `skeleton` and `outline` reported the same truncated extent.
 *
 * Why didn't a test catch this: the R adapter's cases assert on the symbols it emits -- name, kind
 * and start line -- and never on the end line, so a span that stops where it starts satisfies them
 * exactly as a correct one does. Nothing read a real R function back out through the read command
 * either. These cases assert the end line and then read the body through the built binary.
 *
 * The negative cases are what keep the fix honest. R functions do not have to be braced at all
 * (`square <- function(x) x * x` is one expression and genuinely one line), a brace can sit inside a
 * string or a default argument without opening a body, and `setClass` has no body to span. A fix
 * that simply scanned ahead for the next `}` would pass the positive cases and swallow unrelated
 * code in all three of these.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { extractR } from '../../src/languages/r.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, HOME: homeDir, USERPROFILE: homeDir },
  })
  return { status: res.status ?? 1, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

/** The one symbol named `name`, or a failure that names what was found instead. */
function symbolNamed(source: string, name: string): { lineStart: number; lineEnd: number } {
  const found = extractR(source, 'x.R').symbols.filter((s) => s.name === name)
  expect(found, `expected exactly one symbol named ${name}`).toHaveLength(1)
  const s = found[0]
  if (s === undefined) throw new Error('unreachable')
  return { lineStart: s.lineStart, lineEnd: s.lineEnd }
}

const SOURCE = [
  'compute_mean <- function(xs) {',
  '  total <- sum(xs)',
  '  total / length(xs)',
  '}',
  '',
  'square <- function(x) x * x',
  '',
  'scale_values = function(xs, factor) {',
  '  inner <- function(v) {',
  '    v * factor',
  '  }',
  '  sapply(xs, inner)',
  '}',
  '',
  'shorthand <- \\(x) {',
  '  x + 1',
  '}',
  '',
  'brace_on_next_line <- function(x)',
  '{',
  '  x',
  '}',
  '',
  'with_brace_default <- function(sep = "{") {',
  '  sep',
  '}',
  '',
  'setClass("Point", representation(x = "numeric"))',
  '',
  'trailing <- function(x) {',
  '  x',
  '}',
  '',
  'with_paren_default <- function(sep = ")") {',
  '  sep',
  '}',
  '',
  'commented_body <- function(x) # explain',
  '{',
  '  x',
  '}',
  '',
  'brace_in_comment <- function(x) {',
  '  # closing } in prose',
  '  x',
  '}',
  '',
  'paren_in_comment <- function(x, # note )',
  '                             y) {',
  '  x + y',
  '}',
  '',
  'msg <- "see setClass(\'Bogus\') here"',
  '',
  'Assigned <- setClass("Assigned", representation(x = "numeric"))',
  '',
  'backtick_arg <- function(`a)b` = 1) {',
  '  1',
  '}',
  '',
].join('\n')

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-rspan-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-rspan-home-'))
  writeFileSync(join(projectDir, 'analysis.R'), SOURCE)
  run(['index', '.', '--walk'])
})

describe('extractR spans', () => {
  it('ends a braced function at its closing brace, not at its first line', () => {
    expect(symbolNamed(SOURCE, 'compute_mean'), 'the function body was cut off after the signature').toEqual({
      lineStart: 1,
      lineEnd: 4,
    })
  })

  it('keeps an unbraced one-expression function on one line', () => {
    expect(symbolNamed(SOURCE, 'square')).toEqual({ lineStart: 6, lineEnd: 6 })
  })

  it('spans past a nested function rather than stopping at its closing brace', () => {
    expect(symbolNamed(SOURCE, 'scale_values'), 'a nested definition truncated the outer one').toEqual({
      lineStart: 8,
      lineEnd: 13,
    })
  })

  it('spans the backslash lambda shorthand', () => {
    expect(symbolNamed(SOURCE, 'shorthand')).toEqual({ lineStart: 15, lineEnd: 17 })
  })

  it('finds a body brace placed on the following line', () => {
    expect(symbolNamed(SOURCE, 'brace_on_next_line')).toEqual({ lineStart: 19, lineEnd: 22 })
  })

  it('is not fooled by a brace inside a default argument string', () => {
    expect(symbolNamed(SOURCE, 'with_brace_default'), 'a quoted brace was counted as real nesting').toEqual({
      lineStart: 24,
      lineEnd: 26,
    })
  })

  it('leaves setClass, which has no body, on its own line', () => {
    expect(symbolNamed(SOURCE, 'Point')).toEqual({ lineStart: 28, lineEnd: 28 })
  })

  it('ends a function at its own brace rather than running on to the end of the file', () => {
    expect(symbolNamed(SOURCE, 'trailing'), 'the function ran past its own closing brace').toEqual({
      lineStart: 30,
      lineEnd: 32,
    })
  })

  // The brace walk is quote-aware already; the parenthesis walk that finds the end of the parameter
  // list has to be too, or a bracket inside a default value ends the list early and the body brace
  // is looked for in the middle of the signature.
  it('is not fooled by a parenthesis inside a default argument string', () => {
    expect(symbolNamed(SOURCE, 'with_paren_default'), 'a quoted parenthesis closed the parameter list early').toEqual({
      lineStart: 34,
      lineEnd: 36,
    })
  })

  // Codex review of the span walk surfaced these four: each one made the walk read the wrong text,
  // and none of them is visible from a tidy fixture.
  it('treats a comment between the signature and the body as whitespace', () => {
    expect(symbolNamed(SOURCE, 'commented_body'), 'a comment made the function look brace-less').toEqual({
      lineStart: 38,
      lineEnd: 41,
    })
  })

  it('does not end the body at a closing brace that is inside a comment', () => {
    expect(symbolNamed(SOURCE, 'brace_in_comment'), 'prose in a comment closed the body early').toEqual({
      lineStart: 43,
      lineEnd: 46,
    })
  })

  it('does not end the parameter list at a parenthesis inside a comment', () => {
    expect(symbolNamed(SOURCE, 'paren_in_comment'), 'a comment closed the parameter list early').toEqual({
      lineStart: 48,
      lineEnd: 51,
    })
  })

  it('does not invent a class from a call named inside a string', () => {
    const names = extractR(SOURCE, 'x.R').symbols.map((s) => s.name)
    expect(names, 'a quoted mention of setClass produced a symbol for a class that does not exist').not.toContain('Bogus')
  })

  // Backticks quote a name rather than a value in R, so a parameter can legally be called `a)b`
  // and the parenthesis walk has to treat the bracket inside it as text.
  it('does not end the parameter list at a parenthesis inside a backtick-quoted name', () => {
    expect(symbolNamed(SOURCE, 'backtick_arg'), 'a bracket in a quoted parameter name closed the list early').toEqual({
      lineStart: 57,
      lineEnd: 59,
    })
  })

  // A backtick quotes a name in a function BODY too, and such a name may contain a brace. The body
  // walk has to treat the whole backtick span as text, exactly as the parameter walk already does --
  // otherwise a `}` inside it ends the span early and a `{` inside it makes it run on too far.
  it('does not end the body at a closing brace inside a backtick-quoted name', () => {
    const src = 'backtick_close <- function() {\n  `a}b` <- 1\n  return(2)\n}\n'
    expect(symbolNamed(src, 'backtick_close'), 'a brace in a quoted body name closed the body early').toEqual({
      lineStart: 1,
      lineEnd: 4,
    })
  })

  it('does not run the body on past its close when a backtick-quoted name holds an open brace', () => {
    // A trailing symbol after the function is what makes this discriminate: without the fix the open
    // brace inside the backtick inflates the depth so the closing `}` never reaches zero and the span
    // runs to end of file (line 5), not the correct close on line 4.
    const src = 'backtick_open <- function() {\n  `x{y` <- 1\n  return(2)\n}\nafter <- 5\n'
    expect(symbolNamed(src, 'backtick_open'), 'an open brace in a quoted body name pushed the span past its close').toEqual({
      lineStart: 1,
      lineEnd: 4,
    })
  })

  it('still finds a setClass assigned to a variable', () => {
    expect(symbolNamed(SOURCE, 'Assigned')).toEqual({ lineStart: 55, lineEnd: 55 })
  })

  it('does not run to end of file when a body brace is never closed', () => {
    const unterminated = 'broken <- function(x) {\n  x\n'
    const s = symbolNamed(unterminated, 'broken')
    expect(s.lineEnd).toBeGreaterThanOrEqual(s.lineStart)
  })
})

describe('reading an R function through the built binary', () => {
  it('returns the whole body, not the signature alone', () => {
    const r = run(['read', 'analysis.R::compute_mean'])
    expect(r.status, r.out).toBe(0)
    expect(r.out, 'the body was missing from a surgical read').toContain('total / length(xs)')
    expect(r.out).toContain('compute_mean <- function(xs) {')
  })

  it('still returns one line for a function that really is one line', () => {
    const r = run(['read', 'analysis.R::square'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('square <- function(x) x * x')
    expect(r.out, 'an unbraced function swallowed the code after it').not.toContain('scale_values')
  })
})
