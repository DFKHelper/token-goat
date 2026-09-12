/**
 * Source-level test for the Nix adapter (src/languages/nix.ts), following the shape and
 * mutation-testing discipline `tests/fsharp_idx.test.ts` established: one assertion per rule that
 * can silently regress while a >=1-symbol smoke check stays green.
 *
 * Every fixture below is HAND-DERIVED against the Nix Reference Manual's "Syntax"
 * (https://nix.dev/manual/nix/latest/language/syntax) and "String literals"
 * (https://nix.dev/manual/nix/latest/language/string-literals) pages (see nix.ts's module doc for
 * the exact rules cited), independently of nix.ts's own masking loop -- not from this repo's
 * extractor.
 *
 * Fixtures deliberately avoid JS template literals (backticks) wherever the Nix source itself
 * needs a literal `${`: a backtick template literal would parse that `${` as its OWN JS
 * interpolation syntax rather than emitting the two literal characters this file needs to feed to
 * the adapter. Plain single/double-quoted JS strings and `+` concatenation are used instead.
 */
import { describe, expect, it } from 'vitest'

import { extractNix } from '../src/languages/nix.js'

function names(result: readonly { name: string }[]): string[] {
  return result.map((s) => s.name)
}

describe('/* */ block comments do NOT nest (Nix Reference Manual, "Syntax")', () => {
  it('the first */ closes the comment, however many /* appeared inside -- the OPPOSITE of Haskell/OCaml/F#', () => {
    const src = [
      '/* outer',
      '/* inner */',
      'stillInsideRealCode = 1;',
      'trailingCommentTextNotCode */',
      'afterComment = 2;',
    ].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    // The comment closes at the FIRST `*/` (after "inner"), so `stillInsideRealCode` is live code
    // (not swallowed) and the line `trailingCommentTextNotCode */` is live code too (no `=`, so it
    // yields no binding), while `afterComment` is definitely live.
    expect(n).toContain('stillInsideRealCode')
    expect(n).toContain('afterComment')
  })

  it('a plain /* */ comment with no nesting still closes normally', () => {
    const src = ['/* just a comment */', 'realAfter = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    expect(names(result)).toContain('realAfter')
  })
})

describe('# line comments', () => {
  it('a # comment masks a fake definition on the same line, and a real definition after it is found', () => {
    const src = ['# fakeDef = 1;', 'realAfter = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    expect(names(result)).not.toContain('fakeDef')
    expect(names(result)).toContain('realAfter')
  })
})

describe('"..." string interpolation (${...}) with brace-depth tracking', () => {
  it('a } belonging to a nested Nix record literal inside the interpolation does not prematurely close it', () => {
    const src = ['quoted = "value: ${ { a = 1; }.a }";', 'realAfter = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('quoted')
    expect(n).toContain('realAfter')
  })

  it("mutation-discriminating: a } that closes a nested { } one level deep must only decrement the interpolation's brace depth, not close the interpolation itself -- a naive masker that closes on the FIRST } instead pops back to the OUTER string's own content, misreads the very next quote as the OUTER string's own closer, and exposes the fake definition's own line as live top-level code", () => {
    // Correct behavior: `{ a = 1; }` inside the `${...}` is depth-tracked -- the `}` there only
    // decrements depth from 1 to 0, so the interpolation is still open, and the `"` right after it
    // opens a NESTED string (interpolation code can legitimately contain a string literal) that
    // spans across the `fakeCloseTrap` line, masking it, and only closes at the next `"` (start of
    // line 3). The interpolation's REAL closer is the `}` right after that, then the outer string's
    // real closer is the final `"`.
    //
    // A masker that (wrongly) pops the interpolation on the FIRST `}` regardless of depth instead
    // falls back one frame too far, to the OUTER dquote's own content mode; the very next `"` (which
    // should have opened a nested string) is then misread as the OUTER string's own closer, ending
    // it many characters early. Everything from there on -- starting with the whole
    // `fakeCloseTrap = 1;` line -- is then scanned as ordinary, unmasked top-level code.
    const src = [
      'quoted = "value: ${ { a = 1; } "',
      'fakeCloseTrap = 1;',
      '" }";',
      'realAfter = 1;',
    ].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('quoted')
    expect(n).not.toContain('fakeCloseTrap')
    expect(n).toContain('realAfter')
  })

  it('a fake definition written inside a "..." string is not found', () => {
    const src = [
      'quoted = "line one',
      'fakeDef = 1;',
      'real end";',
      'realAfter = 1;',
    ].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('quoted')
    expect(n).not.toContain('fakeDef')
    expect(n).toContain('realAfter')
  })

  it('a backslash-escaped ${ inside a "..." string does not open an interpolation', () => {
    const src = ['quoted = "literal \\${ not interpolated}";', 'realAfter = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('quoted')
    expect(n).toContain('realAfter')
  })
})

describe('\'\'${ / \'\'\' escapes in \'\'...\'\' indented strings (Nix Reference Manual, "String literals")', () => {
  it("mutation-discriminating: ''${ sitting flush against the real closer must not be swallowed by a naive masker that treats it as an interpolation opener plus a plain closer", () => {
    // `''${` here is immediately followed by the real `''` closer with NOTHING else between them.
    // A naive masker that (wrongly) reads `''` as opening then `${` as a real interpolation opener
    // would push an `interp` frame and then scan forward looking for a `}` to close it -- past the
    // fixture's own real string closer and past `trapDef`'s line, swallowing both. The correct
    // implementation recognizes `''${` as the dedicated "literal ${" escape (NOT an interpolation),
    // so the string closes at the very next `''` instead.
    const src = ["escaped = ''literal dollar-brace: ''${''", 'trapDef = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('escaped')
    expect(n).toContain('trapDef')
  })

  it("mutation-discriminating: ''' sitting flush against the real closer must not be swallowed by a naive masker that closes on the first two of the three quotes", () => {
    // `'''` here is immediately followed by the real `''` closer. A naive masker that (wrongly)
    // closes the string at the FIRST two quotes of the `'''` triple would then reopen a new,
    // unrelated indented-string scan starting at the third quote, which runs forward looking for
    // the NEXT `''` -- past the fixture's own real closer and past `trapDef`'s line. The correct
    // implementation recognizes `'''` as the dedicated "literal ''" escape before ever considering
    // a plain two-quote close.
    const src = ["escaped = ''literal two quotes: '''''", 'trapDef = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('escaped')
    expect(n).toContain('trapDef')
  })

  it("a plain (non-doubled) '' string with real \\${} antiquotation still works, contrasting the escape cases above", () => {
    const src = ['greeting = \'\'hello ${"world"}\'\';', 'realAfter = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('greeting')
    expect(n).toContain('realAfter')
  })
})

describe("nested antiquotation: a ${} inside a ''...'' string containing another string with its own ${} (>=2 levels deep)", () => {
  it('a real definition after the whole nested mess is found, and not swallowed as if it were inside the string', () => {
    const src = ['deep = \'\'outer ${"inner ${toString (1 + 1)} end"} tail\'\';', 'realAfter = 1;'].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).toContain('deep')
    expect(n).toContain('realAfter')
  })

  it('a fake definition written inside the deepest nested string is not found', () => {
    const src = [
      'deep = "outer ${"inner ${',
      'fakeDef = 1;',
      '} end"} tail";',
      'realAfter = 1;',
    ].join('\n')
    const result = extractNix(src, 'test.nix')
    const n = names(result)
    expect(n).not.toContain('fakeDef')
    expect(n).toContain('realAfter')
  })
})

describe('let-bound names vs attribute-set keys', () => {
  it('classifies a let-bound name as let_binding and a top-level attribute path as attribute', () => {
    const src = [
      'let',
      '  greeting = "hi";',
      'in',
      '{',
      '  services.foo.enable = true;',
      '}',
    ].join('\n')
    const result = extractNix(src, 'test.nix')
    const greeting = result.find((s) => s.name === 'greeting')
    const attr = result.find((s) => s.name === 'services.foo.enable')
    expect(greeting?.kind).toBe('let_binding')
    expect(attr?.kind).toBe('attribute')
  })
})

describe('performance on pathological input', () => {
  it('masks a ~50KB file with deeply nested, properly-closed antiquotation well under 100ms, and still finds a real definition after it', () => {
    const openRun = '${'.repeat(1000)
    const closeRun = '}'.repeat(1000)
    const deepNesting = 'nested = "' + openRun + 'payload' + closeRun + '";'
    const longIndentedRun = "longRun = ''" + 'z'.repeat(30_000) + "'';"
    const src = [deepNesting.repeat(10), longIndentedRun, 'realAfter = 1;'].join('\n')
    expect(src.length).toBeGreaterThan(50_000)

    const start = performance.now()
    const result = extractNix(src, 'test.nix')
    const elapsed = performance.now() - start

    expect(names(result)).toContain('realAfter')
    expect(elapsed).toBeLessThan(100)
  })

  it('a ~50KB file of many UNMATCHED ${ (no closing }) still terminates in one bounded linear pass well under 100ms', () => {
    // Deliberately pathological and unterminated (per this task's own perf brief): the whole rest
    // of the file after the opening quote is genuine, unterminated string/interpolation content,
    // so this test asserts only on TIME, not on finding a symbol after it -- an unmatched `${` run
    // legitimately swallows everything that follows, the same "runs to end of input" convention
    // this adapter's module doc states for any other unterminated construct.
    const manyOpenInterps = '${'.repeat(30_000)
    const src = 'fakeStart = "' + manyOpenInterps
    expect(src.length).toBeGreaterThan(50_000)

    const start = performance.now()
    extractNix(src, 'test.nix')
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(100)
  })
})
