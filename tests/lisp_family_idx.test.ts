/**
 * Source-level test for the five Lisp-family adapters added in commit 8c16530e
 * (common_lisp.ts, scheme.ts, racket.ts, clojure.ts, emacs_lisp.ts). They shipped with only two
 * enumeration guards (a NESTS classification and a >=1-symbol smoke check) -- neither exercises
 * any dialect-specific masking rule. This file pins the rules that can silently flip while the
 * >=1-symbol guard stays green: nested block comments, datum elision (`#;`/`#_`), the absence of
 * block comments in Clojure/Emacs Lisp, character-literal false-string opens, Racket here-strings
 * and byte strings, the `define` function-vs-variable kind split, and fake definitions embedded
 * in strings/comments.
 *
 * Fixtures below are HAND-DERIVED directly from each dialect's own spec (cited inline), not from
 * the adapters' own regexes/maskers -- see common_lisp.ts/scheme.ts/racket.ts/clojure.ts's module
 * docs for the CLHS/R7RS/Racket-Reference/clojure.org citations this file's fixtures follow.
 */
import { describe, expect, it } from 'vitest'

import { extractCommonLisp } from '../src/languages/common_lisp.js'
import { extractScheme } from '../src/languages/scheme.js'
import { extractRacket } from '../src/languages/racket.js'
import { extractClojure } from '../src/languages/clojure.js'
import { extractEmacsLisp } from '../src/languages/emacs_lisp.js'

function names(result: { symbols: readonly { name: string }[] }): string[] {
  return result.symbols.map((s) => s.name)
}

describe('nested #| |# block comments (CLHS 2.4.8.19 / R7RS 2.2 / Racket Reference "Reading Text")', () => {
  // Each fixture below places the "leaked" definition between the INNER comment's close and the
  // OUTER comment's close. Under correct nesting (depth counter), that span is still inside the
  // outer comment, so the def is absent. Under a non-nesting (first-`|#`-closes) implementation,
  // that inner `|#` would end the whole comment early, leaking the def as live code -- the
  // specific way to get nesting backwards that the "between vs. after" phrasing in the task
  // targets. A fixture where the def sits BEFORE any inner close does not discriminate the two
  // implementations (it is masked either way), so it would not catch this regression.
  it('Common Lisp: a def after the outer close is found; a def leaked by a non-nesting reader is not', () => {
    const src = [
      '#| outer',
      '  #| inner |#',
      '  (defun leaked-if-not-nested () 1)',
      '  still outer |#',
      '(defun after-comment () 2)',
    ].join('\n')
    const result = extractCommonLisp(src, 'test.lisp')
    expect(names(result)).not.toContain('leaked-if-not-nested')
    expect(names(result)).toContain('after-comment')
  })

  it('Scheme: a def after the outer close is found; a def leaked by a non-nesting reader is not', () => {
    const src = [
      '#| outer',
      '  #| inner |#',
      '  (define leaked-if-not-nested 1)',
      '  still outer |#',
      '(define after-comment 2)',
    ].join('\n')
    const result = extractScheme(src, 'test.scm')
    expect(names(result)).not.toContain('leaked-if-not-nested')
    expect(names(result)).toContain('after-comment')
  })

  it('Racket: a def after the outer close is found; a def leaked by a non-nesting reader is not', () => {
    const src = [
      '#| outer',
      '  #| inner |#',
      '  (define leaked-if-not-nested 1)',
      '  still outer |#',
      '(define after-comment 2)',
    ].join('\n')
    const result = extractRacket(src, 'test.rkt')
    expect(names(result)).not.toContain('leaked-if-not-nested')
    expect(names(result)).toContain('after-comment')
  })
})

describe('Clojure and Emacs Lisp have no block comment syntax: #| must be inert', () => {
  it('Clojure: a stray #| in live code does not swallow the rest of the file', () => {
    // #| has no meaning to the Clojure reader at all (clojure.org/reference/reader): it is just
    // two ordinary tokens, `#` (reader-macro dispatch) followed by `|` (a legal symbol char). This
    // fixture keeps it OUTSIDE any comment/string, unlike a `;; #|` fixture, which would pass even
    // if the adapter wrongly treated #| as a block-comment opener (the `;` masker would already
    // have consumed it first, never reaching the #| handling this test means to pin).
    const src = '(def x #| 1)\n(defn after-hash-pipe [] 1)\n'
    const result = extractClojure(src, 'test.clj')
    expect(names(result)).toContain('after-hash-pipe')
  })

  it('Emacs Lisp: a stray #| in live code does not swallow the rest of the file', () => {
    const src = '(defvar x #| 1)\n(defun after-hash-pipe () 1)\n'
    const result = extractEmacsLisp(src, 'test.el')
    expect(names(result)).toContain('after-hash-pipe')
  })
})

describe('datum elision: #; (Scheme/Racket) and #_ (Clojure) drop exactly the elided form', () => {
  it('Scheme: #;(define elided 1) is absent, the following define is present', () => {
    const src = '#;(define elided 1)\n(define kept 2)\n'
    const result = extractScheme(src, 'test.scm')
    expect(names(result)).not.toContain('elided')
    expect(names(result)).toContain('kept')
  })

  it('Scheme: a nested/compound elided datum #;(a (b c)) still lets the following define through', () => {
    const src = '#;(a (b c))\n(define kept 2)\n'
    const result = extractScheme(src, 'test.scm')
    expect(names(result)).toContain('kept')
    expect(result.symbols.length).toBe(1)
  })

  it('Racket: #;(define elided 1) is absent, the following define is present', () => {
    const src = '#;(define elided 1)\n(define kept 2)\n'
    const result = extractRacket(src, 'test.rkt')
    expect(names(result)).not.toContain('elided')
    expect(names(result)).toContain('kept')
  })

  it('Racket: a nested/compound elided datum #;(a (b c)) still lets the following define through', () => {
    const src = '#;(a (b c))\n(define kept 2)\n'
    const result = extractRacket(src, 'test.rkt')
    expect(names(result)).toContain('kept')
    expect(result.symbols.length).toBe(1)
  })

  it('Clojure: #_(defn elided [] 1) is absent, the following defn is present', () => {
    const src = '#_(defn elided [] 1)\n(defn kept [] 2)\n'
    const result = extractClojure(src, 'test.clj')
    expect(names(result)).not.toContain('elided')
    expect(names(result)).toContain('kept')
  })

  it('Clojure: a nested/compound elided datum #_(a (b c)) still lets the following defn through', () => {
    const src = '#_(a (b c))\n(defn kept [] 2)\n'
    const result = extractClojure(src, 'test.clj')
    expect(names(result)).toContain('kept')
    expect(result.symbols.length).toBe(1)
  })
})

describe('character literals must not open a false string', () => {
  // The def after the char literal is kept on the SAME line as the literal, not a later line: the
  // string masker in every one of these adapters already bails out at a bare newline (protection
  // against an unrelated unterminated string swallowing the whole file), so a def placed on the
  // next line would still be found even if the char-literal branch were disabled entirely -- that
  // fixture shape would not discriminate the bug this test means to catch.
  it('Common Lisp: #\\" before a real defun on the same line does not swallow it as an unterminated string', () => {
    const src = '(setf x #\\") (defun after-char-lit () 1)\n'
    const result = extractCommonLisp(src, 'test.lisp')
    expect(names(result)).toContain('after-char-lit')
  })

  it('Scheme: #\\" before a real define on the same line does not swallow it as an unterminated string', () => {
    const src = '(set! x #\\") (define after-char-lit 1)\n'
    const result = extractScheme(src, 'test.scm')
    expect(names(result)).toContain('after-char-lit')
  })

  it('Racket: #\\" before a real define on the same line does not swallow it as an unterminated string', () => {
    const src = '(set! x #\\") (define after-char-lit 1)\n'
    const result = extractRacket(src, 'test.rkt')
    expect(names(result)).toContain('after-char-lit')
  })

  it('Clojure: \\" before a real defn on the same line does not swallow it as an unterminated string', () => {
    const src = '(def x \\") (defn after-char-lit [] 1)\n'
    const result = extractClojure(src, 'test.clj')
    expect(names(result)).toContain('after-char-lit')
  })

  it('Emacs Lisp: ?\\" before a real defun on the same line does not swallow it as an unterminated string', () => {
    const src = '(setq x ?\\") (defun after-char-lit () 1)\n'
    const result = extractEmacsLisp(src, 'test.el')
    expect(names(result)).toContain('after-char-lit')
  })

  it('Emacs Lisp: ?\\C-a control-char escape before a real defun on the same line does not swallow it', () => {
    const src = '(setq x ?\\C-a) (defun after-char-lit () 1)\n'
    const result = extractEmacsLisp(src, 'test.el')
    expect(names(result)).toContain('after-char-lit')
  })
})

describe('Racket here-strings and byte strings', () => {
  it('a here-string body does not produce spurious symbols and a def after it is found', () => {
    const src = '(define doc #<<EOS\n(define fake-inside-here-string 1)\nEOS\n)\n(define after-here-string 2)\n'
    const result = extractRacket(src, 'test.rkt')
    expect(names(result)).not.toContain('fake-inside-here-string')
    expect(names(result)).toContain('after-here-string')
    expect(names(result)).toContain('doc')
  })

  it('a byte string does not swallow a later define', () => {
    const src = '(define data #"raw bytes")\n(define after-byte-string 1)\n'
    const result = extractRacket(src, 'test.rkt')
    expect(names(result)).toContain('after-byte-string')
  })
})

describe('define shorthand reports a different kind than plain define', () => {
  it('Scheme: (define (f x) ...) is a function, (define x val) is a variable', () => {
    const src = '(define (f x) (+ x 1))\n(define y 42)\n'
    const result = extractScheme(src, 'test.scm')
    const fn = result.symbols.find((s) => s.name === 'f')
    const v = result.symbols.find((s) => s.name === 'y')
    expect(fn?.kind).toBe('function')
    expect(v?.kind).toBe('variable')
    expect(fn?.kind).not.toBe(v?.kind)
  })

  it('Racket: (define (f x) ...) is a function, (define x val) is a variable', () => {
    const src = '(define (f x) (+ x 1))\n(define y 42)\n'
    const result = extractRacket(src, 'test.rkt')
    const fn = result.symbols.find((s) => s.name === 'f')
    const v = result.symbols.find((s) => s.name === 'y')
    expect(fn?.kind).toBe('function')
    expect(v?.kind).toBe('variable')
    expect(fn?.kind).not.toBe(v?.kind)
  })
})

describe('a definition-shaped form inside a real string or line comment is not extracted', () => {
  it('Common Lisp: a defun-shaped line comment produces no symbol for the fake name', () => {
    const src = ';; (defun fake () 1)\n(defun real () 2)\n'
    const result = extractCommonLisp(src, 'test.lisp')
    expect(names(result)).not.toContain('fake')
    expect(names(result)).toContain('real')
  })

  it('Common Lisp: a defun-shaped form inside a string literal produces no symbol for the fake name', () => {
    const src = '(defvar *doc* "(defun fake-in-string () 1)")\n(defun real () 2)\n'
    const result = extractCommonLisp(src, 'test.lisp')
    expect(names(result)).not.toContain('fake-in-string')
    expect(names(result)).toContain('real')
  })

  it('Clojure: a defn-shaped form inside a string literal produces no symbol for the fake name', () => {
    const src = '(def doc "(defn fake-in-string [] 1)")\n(defn real [] 2)\n'
    const result = extractClojure(src, 'test.clj')
    expect(names(result)).not.toContain('fake-in-string')
    expect(names(result)).toContain('real')
  })

  it('Emacs Lisp: a defun-shaped form inside a string literal produces no symbol for the fake name', () => {
    const src = '(defvar doc "(defun fake-in-string () 1)")\n(defun real () 2)\n'
    const result = extractEmacsLisp(src, 'test.el')
    expect(names(result)).not.toContain('fake-in-string')
    expect(names(result)).toContain('real')
  })
})
