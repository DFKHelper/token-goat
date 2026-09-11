/**
 * Guard: a delimiter sitting inside an opaque string literal must not steer a span walk.
 *
 * Two span walks read raw source a character at a time and decide where a symbol ends: R's own
 * parameter-list scan plus the brace scan behind it, and `assignBraceBlockSpans` for the
 * brace-delimited languages. Both used to know only the literal forms whose delimiters are fixed,
 * so a literal whose closer is decided by its opener stayed invisible to them: R's raw character
 * constant (`r"(...)"`) and PHP's heredoc (`<<<EOT`). The content of either is verbatim, so it may
 * hold an unpaired `"` -- and once a walk re-pairs the quotes inside one, the very next `)` or `}`
 * in that literal's text reads as a real delimiter and the enclosing symbol ends on that line.
 *
 * Every case here asserts exact bounds. A span assertion that only checks the symbol exists passes
 * against the wrong span just as happily as the right one: in each of these fixtures the symbol was
 * always found, it was its extent that was wrong.
 *
 * Fixture provenance: FORMAT-DERIVED. R raw character constant syntax (quote, optional dash run,
 * mirrored bracket) is from the R base help page `?Quotes`, section "Raw character constants",
 * added in R 4.0.0. PHP heredoc syntax is from the PHP Manual, "Strings", section "Heredoc". The
 * expected line numbers are HAND-DERIVED: counted off the fixture text, not read from any output.
 */
import { describe, expect, it } from 'vitest'

import { assignBraceBlockSpans } from '../../src/languages/common.js'
import { extractPhp } from '../../src/languages/php.js'
import { extractR } from '../../src/languages/r.js'

/** Every symbol as `name lineStart-lineEnd`, so a failure names the span that was wrong. */
function spans(symbols: readonly { name: string; lineStart: number; lineEnd: number }[]): string[] {
  return symbols.map((s) => `${s.name} ${s.lineStart}-${s.lineEnd}`)
}

function rSpans(source: string): string[] {
  return spans(extractR(source, 'x.R').symbols)
}

/** Mirrors the `php` entry of parser.ts's adapter table, which is what supplies a PHP member's span. */
function phpSpans(source: string): string[] {
  return spans(assignBraceBlockSpans(extractPhp(source, 'x.php').symbols, source, {
    lineComment: ['//', '#'],
    lineCommentExceptions: ['#['],
    multilineLang: 'php',
  }))
}

describe('span walks and opaque literals', () => {
  it('does not end an R parameter list at the closing bracket of a raw constant default', () => {
    const source = [
      'f <- function(x = r"(a"b)") {',
      '  1',
      '}',
      '',
      'g <- function() {',
      '  2',
      '}',
      '',
    ].join('\n')
    expect(rSpans(source)).toEqual(['f 1-3', 'g 5-7'])
  })

  it('does not end an R function body at a brace inside a raw constant', () => {
    const source = [
      'h <- function() {',
      '  s <- r"(a"b})"',
      '  s',
      '}',
      '',
    ].join('\n')
    expect(rSpans(source)).toEqual(['h 1-4'])
  })

  it('honours the dash padding and the square-bracket spelling of an R raw constant', () => {
    const source = [
      'p <- function(sep = r"--[a"b]--") {',
      '  sep',
      '}',
      '',
    ].join('\n')
    expect(rSpans(source)).toEqual(['p 1-3'])
  })

  it('reads a raw constant only where the r prefix is a token of its own', () => {
    // `var"(` is the tail of an identifier followed by an ordinary constant, not a raw one, so the
    // walk must fall back to its quote rules and still close the parameter list on line 1.
    const source = [
      'q <- function(x = var + "(a)") {',
      '  x',
      '}',
      '',
    ].join('\n')
    expect(rSpans(source)).toEqual(['q 1-3'])
  })

  it('does not end an R setClass call at the closing bracket of a raw constant argument', () => {
    const source = [
      'setClass("A",',
      '  prototype = prototype(z = r"(a"b)"),',
      '  representation(x = "numeric")',
      ')',
      '',
      'k <- function() 1',
      '',
    ].join('\n')
    expect(rSpans(source)).toEqual(['A 1-4', 'k 6-6'])
  })

  it('does not end a PHP method at a brace inside a heredoc body', () => {
    const source = [
      '<?php',
      'class A {',
      '  public function f() {',
      '    $s = <<<EOT',
      'a } b',
      'EOT;',
      '    return $s;',
      '  }',
      '  public function g() {',
      '    return 2;',
      '  }',
      '}',
      '',
    ].join('\n')
    expect(phpSpans(source)).toEqual(['A 2-12', 'f 3-8', 'g 9-11'])
  })
})
