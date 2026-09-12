/**
 * Source-level test for the OCaml adapter (src/languages/ocaml.ts), following the shape and
 * mutation-testing discipline `tests/haskell_idx.test.ts` established: one assertion per rule
 * that can silently regress while a >=1-symbol smoke check stays green.
 *
 * Every fixture below is HAND-DERIVED from The OCaml Manual's Lexical conventions chapter
 * (https://v2.ocaml.org/manual/lex.html), independently of ocaml.ts's own regexes and masking
 * loop -- not from this repo's extractor.
 */
import { describe, expect, it } from 'vitest'

import { extractOcaml } from '../src/languages/ocaml.js'

function names(result: readonly { name: string }[]): string[] {
  return result.map((s) => s.name)
}

describe('nested (* *) block comments (The OCaml Manual, "Comments", https://v2.ocaml.org/manual/lex.html#sss:lex:comments)', () => {
  it('a definition after the outer close is found; a definition leaked by a non-nesting reader is not', () => {
    const src = [
      '(* outer',
      '(* inner *)',
      'let leakedIfNotNested = 1',
      'still outer *)',
      'let afterComment = 2',
    ].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).not.toContain('leakedIfNotNested')
    expect(names(result)).toContain('afterComment')
  })

  it('a plain (* *) comment with no string inside still closes normally', () => {
    const src = ['(* just a comment *)', 'let realAfter = 1'].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('realAfter')
  })
})

describe('a string literal inside a comment is lexed as a string, so an embedded "*)" does not close the comment (manual: "Comments do not occur inside string or character literals")', () => {
  it('correct, string-aware behavior: the comment only ends at the real closing "*)", after the string genuinely closes -- everything up to then, including a line that looks like a top-level definition, stays inside the comment', () => {
    const src = [
      '(* " early *)',
      'let fakeDef = 1',
      'closes string here " really closes now *)',
      'let realAfter = 1',
    ].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).not.toContain('fakeDef')
    expect(names(result)).toContain('realAfter')
  })

  it('pins the exact symbol set (not just an absence check), so a regression to naive non-string-aware depth counting is caught precisely: a naive masker closes the comment right after "leaked comment", making fakeDef live code', () => {
    const src = [
      '(* " early *)',
      'let fakeDef = 1',
      'closes string here " really closes now *)',
      'let realAfter = 1',
    ].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toEqual(['realAfter'])
  })
})

describe('{id|...|id} quoted string literals (manual, "String literals", https://v2.ocaml.org/manual/lex.html#sss:stringliterals)', () => {
  it('a quoted string body is not interpreted specially: an embedded quote or backslash does not end the string early or need escaping', () => {
    const src = [String.raw`let quoted = {|contains " and \ with no escaping needed|}`, 'let realAfter = 1'].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('quoted')
    expect(names(result)).toContain('realAfter')
  })

  it('a quoted string with a non-empty id only closes at the matching "|id}", not at a bare "|}": a definition leaked by a bare-"|}" reader is not found', () => {
    const src = [
      'let quoted = {tag|opens here |} inside',
      'let shouldStayMasked = 999',
      'still inside the string|tag}',
      'let realAfter = 1',
    ].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('quoted')
    expect(names(result)).not.toContain('shouldStayMasked')
    expect(names(result)).toContain('realAfter')
  })
})

describe('"..." string escaping (manual, "String literals")', () => {
  it('an escaped quote inside a string does not end the string early: a bare identifier does not get promoted by leftover string content', () => {
    const src = [String.raw`let notAnEquation = "esc \" still inside"`, 'let realAfter = 1'].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('notAnEquation')
    expect(names(result)).toContain('realAfter')
  })

  it('a string literal may span multiple lines (manual: no bare-newline safety net, unlike Haskell); a line that looks like a definition but is really still inside the string is not found', () => {
    const src = ['let multiline = "line one', 'let fakeDef = 1', 'real end"', 'let realAfter = 1'].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('multiline')
    expect(names(result)).not.toContain('fakeDef')
    expect(names(result)).toContain('realAfter')
  })
})

describe("'a type-variable vs 'c' character-literal disambiguation (manual, \"Character literals\")", () => {
  it("a bare type-variable tick ('a) is not treated as an unterminated character literal that scans forward for the next quote: a later definition, and a later string containing an apostrophe, are both still found on their own lines", () => {
    // If a masker mistook this `'a` for a Haskell-style character literal and scanned forward for
    // the next `'` to close it (rather than requiring the closing quote at the fixed lookahead a
    // real OCaml character literal always has), it would find the apostrophe inside "it's fine"
    // on a much later line and blank everything in between -- swallowing realAfter's own line.
    const src = ["let f : 'a -> int = fun x -> 0", `let realAfter = "it's fine"`].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('f')
    expect(names(result)).toContain('realAfter')
  })

  // The next two are correctness/regression pins, not independently mutation-discriminating: a
  // top-level `let name = ...` binding's name is captured from the prefix before `=`, so how the
  // RHS character literal is masked cannot change whether `name` itself is found here (that
  // dependency only shows up when masking a literal's content wrongly crosses into a NEW line, as
  // pinned by the type-variable/multi-line-string tests above).
  it("a character literal containing '=' does not error and still yields its binding's name", () => {
    const src = ["let notAnEquation = '='", '', 'let realAfter = 1'].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('notAnEquation')
    expect(names(result)).toContain('realAfter')
  })

  it("an escaped character literal ('\\n', '\\'', '\\065') does not error and still yields its binding's name", () => {
    const src = [
      String.raw`let newline = '\n'`,
      String.raw`let quote = '\''`,
      String.raw`let numeric = '\065'`,
      'let realAfter = 1',
    ].join('\n')
    const result = extractOcaml(src, 'test.ml')
    expect(names(result)).toContain('newline')
    expect(names(result)).toContain('quote')
    expect(names(result)).toContain('numeric')
    expect(names(result)).toContain('realAfter')
  })
})

describe('module, type, exception, class, and let declarations', () => {
  it('extracts a let binding, a type, an exception, a class, and a module', () => {
    const src = [
      'let greet name = "hello, " ^ name',
      '',
      'type shape =',
      '  | Circle of float',
      '  | Rectangle of float * float',
      '',
      'exception Bad_shape of string',
      '',
      'class sizeable =',
      '  object',
      '    method size = 0.0',
      '  end',
      '',
      'module Sample = struct',
      '  let id x = x',
      'end',
    ].join('\n')
    const result = extractOcaml(src, 'test.ml')
    const n = names(result)
    expect(n).toContain('greet')
    expect(n).toContain('shape')
    expect(n).toContain('Bad_shape')
    expect(n).toContain('sizeable')
    expect(n).toContain('Sample')
    // `let id x = x`, nested inside the module, is indented and so is not a top-level boundary.
    expect(n).not.toContain('id')
  })
})

describe('performance on pathological input', () => {
  it('masks and extracts a ~50KB file of deeply nested block comments and a long string-in-comment run well under 100ms', () => {
    const nested = '(* '.repeat(2000) + 'payload' + ' *)'.repeat(2000)
    const stringInComment = `(* " ${'x'.repeat(20_000)} " *)`
    const longString = `let bigString = "${'y'.repeat(20_000)}"`
    const src = [nested, stringInComment, longString, 'let realAfter = 1'].join('\n')
    expect(src.length).toBeGreaterThan(50_000)

    const start = performance.now()
    const result = extractOcaml(src, 'test.ml')
    const elapsed = performance.now() - start

    expect(names(result)).toContain('realAfter')
    expect(elapsed).toBeLessThan(100)
  })
})
