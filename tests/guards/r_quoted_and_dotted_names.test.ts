/**
 * Guard: R's two non-plain definition spellings must be indexed, and only those.
 *
 * The R adapter matched a definition name with `[A-Za-z_][A-Za-z0-9_.]*`, which excludes both of
 * the spellings real R code leans on hardest. A backtick-quoted name is how every infix operator
 * is defined (`` `%+%` <- function(a, b) ``, the exact form magrittr's own `%>%` uses) and how
 * every S3 method on an operator or extractor generic is defined (`` `[.myclass` <- ``,
 * `` `+.difftime` <- ``, `` `myattr<-` <- ``). A leading dot is a legal R name start and is what
 * a package's own load hooks are called (`.onLoad`, `.onAttach`). Neither produced a symbol, so
 * `symbol`, `read`, `skeleton` and `outline` all answered "not found" for functions that are
 * plainly there in the file -- silent loss, with no error to show for it.
 *
 * Why didn't a test catch this: every existing R case names its fixture functions in the plain
 * `snake_case` spelling the regex already accepted, so the two excluded spellings were never once
 * fed to the extractor. tests/guards/r_function_span.test.ts does exercise backticks, but only
 * inside a parameter list and inside a body -- never as the defined name itself.
 *
 * The negative cases keep the fix honest in the other direction: widening the name group to
 * something permissive (`(.+?)`) would start matching assignments into a container --
 * `obj$handler <- function(x) x`, `lst[["k"]] <- function(x) x` -- which are not named top-level
 * definitions and must stay unindexed, and would invent a symbol out of an operator merely being
 * called.
 */
import { describe, expect, it } from 'vitest'

import { extractR } from '../../src/languages/r.js'

/** The one symbol named `name`, or a failure that names what was found instead. */
function symbolNamed(source: string, name: string): { lineStart: number; lineEnd: number } {
  const all = extractR(source, 'x.R').symbols
  const found = all.filter((s) => s.name === name)
  expect(found, `expected exactly one symbol named ${name}, got [${all.map((s) => s.name).join(', ')}]`).toHaveLength(1)
  const s = found[0]
  if (s === undefined) throw new Error('unreachable')
  return { lineStart: s.lineStart, lineEnd: s.lineEnd }
}

const SOURCE = [
  '.onLoad <- function(libname, pkgname) {',
  '  options(demo.verbose = TRUE)',
  '  invisible()',
  '}',
  '',
  '`%+%` <- function(a, b) {',
  '  paste0(a, b)',
  '}',
  '',
  '`[.myclass` <- function(x, i) {',
  '  unclass(x)[i]',
  '}',
  '',
  'plain_fn <- function(z) {',
  '  z',
  '}',
  '',
].join('\n')

const NEGATIVE = [
  'obj$handler <- function(x) x',
  'lst[["k"]] <- function(x) x',
  'res <- a %+% b',
  '',
].join('\n')

describe('extractR quoted and dotted definition names', () => {
  it('indexes a dot-prefixed name such as the .onLoad package hook', () => {
    expect(symbolNamed(SOURCE, '.onLoad'), 'a leading dot dropped the definition from the index entirely').toEqual({
      lineStart: 1,
      lineEnd: 4,
    })
  })

  it('indexes a backtick-quoted infix operator definition under its bare operator name', () => {
    expect(symbolNamed(SOURCE, '%+%'), 'a backtick-quoted operator definition produced no symbol').toEqual({
      lineStart: 6,
      lineEnd: 8,
    })
  })

  it('indexes a backtick-quoted S3 extractor method definition', () => {
    expect(symbolNamed(SOURCE, '[.myclass'), 'a backtick-quoted S3 method definition produced no symbol').toEqual({
      lineStart: 10,
      lineEnd: 12,
    })
  })

  it('still indexes an ordinary plain-named function alongside them', () => {
    expect(symbolNamed(SOURCE, 'plain_fn')).toEqual({ lineStart: 14, lineEnd: 16 })
  })

  it('stores the backticks-stripped name, not the quoted spelling', () => {
    const names = extractR(SOURCE, 'x.R').symbols.map((s) => s.name)
    expect(names, 'the stored name kept its backticks, so a lookup by the operator name misses it').not.toContain('`%+%`')
  })

  it('does not invent a symbol for an assignment into a container or for a mere operator call', () => {
    const names = extractR(NEGATIVE, 'x.R').symbols.map((s) => s.name)
    expect(names, 'a permissive name group matched an assignment into a container or a call site').toEqual([])
  })
})
