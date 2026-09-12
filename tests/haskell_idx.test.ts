/**
 * Source-level test for the Haskell adapter (src/languages/haskell.ts), following the shape and
 * mutation-testing discipline `tests/lisp_family_idx.test.ts` established for the five Lisp-family
 * adapters: one assertion per rule that can silently regress while a >=1-symbol smoke check stays
 * green.
 *
 * Every fixture below is HAND-DERIVED from the Haskell 2010 Language Report sections cited inline
 * (https://www.haskell.org/onlinereport/haskell2010/), independently of haskell.ts's own regexes
 * and masking loop -- not from this repo's extractor.
 *
 * This adapter's top-level definitions are found by column-0 boundary (see haskell.ts's module
 * doc), which means a line's own classification depends only on the text BEFORE its first `=`/
 * `::` -- text after that point (a string or character literal's payload) never changes which
 * symbol gets created. So a masking bug in a string/character literal cannot be pinned by asking
 * "does the right symbol still appear" the way the Lisp tests do for a def on the same line as a
 * char literal; it has to be pinned by asking "does an otherwise-non-definition line stay a
 * non-definition" -- a stray `=` character inside an unmasked comment/string/char literal is
 * exactly the kind of leaked content that would wrongly promote a bare identifier line into a
 * fake equation. Each masking test below is built that way, and each was confirmed to flip red
 * under a targeted mutation of the rule it pins (see the coder's report for the captured output).
 */
import { describe, expect, it } from 'vitest'

import { extractHaskell } from '../src/languages/haskell.js'

function names(result: readonly { name: string }[]): string[] {
  return result.map((s) => s.name)
}

describe('nested {- -} block comments (Haskell 2010 Report section 2.3, "Comments")', () => {
  it('a definition after the outer close is found; a definition leaked by a non-nesting reader is not', () => {
    const src = [
      '{- outer',
      '{- inner -}',
      'leakedIfNotNested :: Int',
      'leakedIfNotNested = 1',
      'still outer -}',
      'afterComment :: Int',
      'afterComment = 2',
    ].join('\n')
    const result = extractHaskell(src, 'test.hs')
    expect(names(result)).not.toContain('leakedIfNotNested')
    expect(names(result)).toContain('afterComment')
  })
})

describe('the "--" comment rule (Report section 2.3 + the varsym/dashes exclusion in section 2.4)', () => {
  it('a run of dashes followed by a symbol character is a legal lexeme, not a comment: "-->" used as an infix operator does not hide the real "=" after it', () => {
    // Report 2.3: '"-->" ... do not begin a comment, because ... [it is a] legal lexeme.' If a
    // masker wrongly treats "--" as a comment opener regardless of what follows, it blanks
    // everything from "-->" to end of line, including the defining "= True" -- so this single
    // clause's own "checkPositive" would never be classified as an equation at all.
    const src = ['checkPositive x | x --> 0 = True', '', 'realAfter :: Int', 'realAfter = 42'].join('\n')
    const result = extractHaskell(src, 'test.hs')
    expect(names(result)).toContain('checkPositive')
    expect(names(result)).toContain('realAfter')
  })

  it('a genuine "--" comment masks a stray "=" inside it, so a bare identifier followed only by a comment is not mistaken for an equation', () => {
    const src = ['justAName -- this text has a stray = sign in it', '', 'realDef :: Int', 'realDef = 1'].join('\n')
    const result = extractHaskell(src, 'test.hs')
    expect(names(result)).not.toContain('justAName')
    expect(names(result)).toContain('realDef')
  })
})

describe('string/character literal escaping (Report section 2.6)', () => {
  it('a character literal containing "=" is masked, so a bare identifier applying it is not mistaken for an equation', () => {
    const src = ["notAnEquation '='", '', 'realAfter :: Int', 'realAfter = 1'].join('\n')
    const result = extractHaskell(src, 'test.hs')
    expect(names(result)).not.toContain('notAnEquation')
    expect(names(result)).toContain('realAfter')
  })

  it('an escaped quote inside a string does not end the string early: a bare identifier applying such a string is not mistaken for an equation', () => {
    // If `\"` wrongly closed the string, the leftover ` a = b"` becomes live text containing a
    // bare "=", wrongly promoting this bare-identifier-applied-to-a-string line into an equation.
    const src = ['notAnEquation "esc \\" a = b"', '', 'realAfter :: Int', 'realAfter = 1'].join('\n')
    const result = extractHaskell(src, 'test.hs')
    expect(names(result)).not.toContain('notAnEquation')
    expect(names(result)).toContain('realAfter')
  })

  it('an unterminated string does not swallow the rest of the file (safety net at a bare newline)', () => {
    const src = ['broken = "never closed', '', 'realAfter :: Int', 'realAfter = 1'].join('\n')
    const result = extractHaskell(src, 'test.hs')
    expect(names(result)).toContain('realAfter')
  })
})

describe('a Template Haskell quote (bare \' before a constructor/type name) is not mistaken for a character literal', () => {
  it('does not swallow real code on the same line as an unterminated string', () => {
    const src = ["promoted :: a", "promoted = 'Just", '', 'realAfter :: Int', 'realAfter = 1'].join('\n')
    const result = extractHaskell(src, 'test.hs')
    expect(names(result)).toContain('realAfter')
  })
})

describe('module, data, class, and instance declarations', () => {
  it('extracts a module header, a data type, a type signature, a function equation, a class, and an instance', () => {
    const src = [
      'module Sample (greet) where',
      '',
      'greet :: String -> String',
      'greet name = "hello, " ++ name',
      '',
      'data Shape = Circle Double | Rect Double Double',
      '',
      'class Sizeable a where',
      '  size :: a -> Double',
      '',
      'instance Sizeable Shape where',
      '  size (Circle r) = r',
      '  size (Rect w h) = w * h',
    ].join('\n')
    const result = extractHaskell(src, 'test.hs')
    const n = names(result)
    expect(n).toContain('Sample')
    expect(n).toContain('greet')
    expect(n).toContain('Shape')
    expect(n).toContain('Sizeable')
    expect(result.find((s) => s.kind === 'instance' && s.name.includes('Sizeable'))).toBeDefined()
  })

  it('merges multiple equations of the same top-level name into one symbol spanning all of them', () => {
    const src = ['fact :: Int -> Int', 'fact 0 = 1', 'fact n = n * fact (n - 1)', '', 'after :: Int', 'after = 1'].join('\n')
    const result = extractHaskell(src, 'test.hs')
    const factSymbols = result.filter((s) => s.name === 'fact' && s.kind === 'function')
    expect(factSymbols.length).toBe(1)
    expect(factSymbols[0]!.lineEnd).toBeGreaterThanOrEqual(3)
    expect(names(result)).toContain('after')
  })
})

describe('performance on pathological input (a prior nested-comment masker regressed 33ms to 1847ms; see the module doc)', () => {
  it('masks and extracts a ~50KB file of deeply nested block comments and long dash/symbol runs well under 100ms', () => {
    const nested = '{- '.repeat(2000) + 'payload' + ' -}'.repeat(2000)
    const dashRuns = Array.from({ length: 500 }, (_, i) => `dashLine${i} ---------> ${i}`).join('\n')
    const longString = `bigString = "${'x'.repeat(35_000)}"`
    const src = [nested, dashRuns, longString, 'realAfter :: Int', 'realAfter = 1'].join('\n')
    expect(src.length).toBeGreaterThan(50_000)

    const start = performance.now()
    const result = extractHaskell(src, 'test.hs')
    const elapsed = performance.now() - start

    expect(names(result)).toContain('realAfter')
    expect(elapsed).toBeLessThan(100)
  })
})
