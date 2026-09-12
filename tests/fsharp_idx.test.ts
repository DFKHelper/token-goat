/**
 * Source-level test for the F# adapter (src/languages/fsharp.ts), following the shape and
 * mutation-testing discipline `tests/ocaml_idx.test.ts` established: one assertion per rule that
 * can silently regress while a >=1-symbol smoke check stays green.
 *
 * Every fixture below is HAND-DERIVED from the F# Language Specification's lexical rules for
 * comments and string literals (see fsharp.ts's module doc for section citations and the
 * no-internet-access caveat), independently of fsharp.ts's own regexes and masking loop -- not
 * from this repo's extractor.
 */
import { describe, expect, it } from 'vitest'

import { extractFSharp } from '../src/languages/fsharp.js'

function names(result: readonly { name: string }[]): string[] {
  return result.map((s) => s.name)
}

describe('nested (* *) block comments (F# Language Specification section 3.2, "Comments")', () => {
  it('a definition after the outer close is found; a definition leaked by a non-nesting reader is not', () => {
    const src = [
      '(* outer',
      '(* inner *)',
      'let leakedIfNotNested = 1',
      'still outer *)',
      'let afterComment = 2',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).not.toContain('leakedIfNotNested')
    expect(names(result)).toContain('afterComment')
  })

  it('a definition between the inner close and the outer close is NOT found (still inside the outer comment)', () => {
    const src = [
      '(* outer',
      '(* inner *)',
      'let stillInsideOuter = 1',
      'still outer *)',
      'let afterComment = 2',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).not.toContain('stillInsideOuter')
    expect(names(result)).toContain('afterComment')
  })

  it('a plain (* *) comment with no string inside still closes normally', () => {
    const src = ['(* just a comment *)', 'let realAfter = 1'].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('realAfter')
  })
})

describe('a string literal inside a (* *) comment is lexed as a string, so an embedded "*)" does not close the comment (the well-known F# "stray quote in a comment swallows the file" gotcha)', () => {
  it('correct, string-aware behavior: the comment only ends at the real closing "*)", after the string genuinely closes', () => {
    const src = [
      '(* " early *)',
      'let fakeDef = 1',
      'closes string here " really closes now *)',
      'let realAfter = 1',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).not.toContain('fakeDef')
    expect(names(result)).toContain('realAfter')
  })

  it('pins the exact symbol set (not just an absence check), so a regression to naive non-string-aware depth counting is caught precisely', () => {
    const src = [
      '(* " early *)',
      'let fakeDef = 1',
      'closes string here " really closes now *)',
      'let realAfter = 1',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toEqual(['realAfter'])
  })
})

describe('// line comments', () => {
  it('a // comment masks a fake definition on the same style of line, and a real definition after it is found', () => {
    const src = ['// let fakeDef = 1', 'let realAfter = 1'].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).not.toContain('fakeDef')
    expect(names(result)).toContain('realAfter')
  })
})

describe('@"..." verbatim strings: "" is the only escape, a backslash is always literal (F# Language Specification, "String, Character, and Byte Array Literals")', () => {
  // NOT independently mutation-discriminating: a doubled `""` sits at two immediately-adjacent
  // positions, so a masker that (wrongly) closes the string at the first of the pair has its very
  // next character be the second of the pair, which the outer masking loop then reopens as a new
  // plain string that scans forward to the same real closer -- the two wrong spans compose back to
  // the same net masked range for a fixture with nothing else between the pair and the real
  // closer. Kept as a correctness/regression pin (same shape ocaml_idx.test.ts documents for its
  // own char-literal-with-equals tests); the trailing-backslash-before-the-closer test below is
  // this rule's actual mutation-discriminating case.
  it('a doubled "" inside a verbatim string does not end the string early: a definition leaked by reading the first quote as a closer is not found', () => {
    const src = [
      String.raw`let quoted = @"a ""quoted"" string"`,
      'let realAfter = 1',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('quoted')
    expect(names(result)).toContain('realAfter')
  })

  it('mutation-discriminating: a naive backslash-aware masker treats the backslash right before the closing quote as an escape and reads past the real closer; the correct implementation must not', () => {
    // `@"C:\"` -- the trailing backslash is a literal character, not an escape: the string's real
    // content is `C:\` and it closes at that final `"`. A naive masker that treats `\` as an escape
    // character here would see that `"` as escaped (not a closer), so it keeps scanning for the
    // next quote and finds none on the rest of the file -- swallowing `trapDef`'s own line, and
    // every line after it, into the "string".
    const src = [
      String.raw`let winPath = @"C:\"`,
      'let trapDef = 1',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('winPath')
    expect(names(result)).toContain('trapDef')
  })

  it('a normal (non-verbatim) backslash-escaped string used elsewhere still works: contrast for the mutation-discriminating case above', () => {
    const src = [String.raw`let escaped = "C:\\"`, 'let realAfter = 1'].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('escaped')
    expect(names(result)).toContain('realAfter')
  })

  it('a normal (non-verbatim) string with the same backslash-n content DOES treat \\n as an escape sequence (contrast case for the same input shape)', () => {
    const src = [
      String.raw`let normal = "C:\temp\n"`,
      'let realAfter = 1',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('normal')
    expect(names(result)).toContain('realAfter')
  })
})

describe('"""..."""triple-quoted strings (not escape-processed)', () => {
  it('an embedded quote or backslash inside a triple-quoted string does not end it early; only a real run of three quotes closes it', () => {
    const src = [
      String.raw`let tripled = """contains " and \ and "" with no escaping needed"""`,
      'let realAfter = 1',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('tripled')
    expect(names(result)).toContain('realAfter')
  })

  it('a triple-quoted string spanning lines does not leak a fake definition inside it', () => {
    const src = [
      'let tripled = """line one',
      'let fakeDef = 1',
      'real end"""',
      'let realAfter = 1',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('tripled')
    expect(names(result)).not.toContain('fakeDef')
    expect(names(result)).toContain('realAfter')
  })
})

describe('"..." normal string escaping', () => {
  it('an escaped quote inside a string does not end the string early', () => {
    const src = [String.raw`let notAnEquation = "esc \" still inside"`, 'let realAfter = 1'].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('notAnEquation')
    expect(names(result)).toContain('realAfter')
  })

  it('a string literal may span multiple lines, matching OCaml: a line that looks like a definition but is really still inside the string is not found', () => {
    const src = ['let multiline = "line one', 'let fakeDef = 1', 'real end"', 'let realAfter = 1'].join('\n')
    const result = extractFSharp(src, 'test.fs')
    expect(names(result)).toContain('multiline')
    expect(names(result)).not.toContain('fakeDef')
    expect(names(result)).toContain('realAfter')
  })
})

describe('namespace, module, type, exception, and let declarations', () => {
  it('extracts a namespace, a let binding, a type, an exception, and a nested module (module member not top-level)', () => {
    const src = [
      'namespace Sample',
      '',
      'let greet name = "hello, " + name',
      '',
      'type Shape =',
      '  | Circle of float',
      '  | Rectangle of float * float',
      '',
      'exception BadShape of string',
      '',
      'module Inner =',
      '  let id x = x',
    ].join('\n')
    const result = extractFSharp(src, 'test.fs')
    const n = names(result)
    expect(n).toContain('Sample')
    expect(n).toContain('greet')
    expect(n).toContain('Shape')
    expect(n).toContain('BadShape')
    expect(n).toContain('Inner')
    // `let id x = x`, nested inside the module, is indented and so is not a top-level boundary.
    expect(n).not.toContain('id')
  })
})

describe('performance on pathological input', () => {
  it('masks and extracts a ~50KB file of deeply nested block comments and a long verbatim-string run well under 100ms', () => {
    const nested = '(* '.repeat(2000) + 'payload' + ' *)'.repeat(2000)
    const stringInComment = `(* " ${'x'.repeat(20_000)} " *)`
    const longVerbatim = `let bigVerbatim = @"${'y'.repeat(20_000)}"`
    const src = [nested, stringInComment, longVerbatim, 'let realAfter = 1'].join('\n')
    expect(src.length).toBeGreaterThan(50_000)

    const start = performance.now()
    const result = extractFSharp(src, 'test.fs')
    const elapsed = performance.now() - start

    expect(names(result)).toContain('realAfter')
    expect(elapsed).toBeLessThan(100)
  })
})
