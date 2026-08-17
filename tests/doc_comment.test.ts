import { describe, expect, it } from 'vitest'

import { precedingDocComment } from '../src/doc_comment.js'

describe('precedingDocComment', () => {
  describe("'c' style block comments", () => {
    it('reads a multi-line block comment directly above the symbol', () => {
      const lines = ['/**', ' * Does the thing.', ' * @param x the thing', ' */', 'function f() {}']
      expect(precedingDocComment(lines, 5, 'c')).toBe('Does the thing.\n@param x the thing')
    })

    it('reads a single-line block comment directly above the symbol', () => {
      const lines = ['/* Does the thing. */', 'function f() {}']
      expect(precedingDocComment(lines, 2, 'c')).toBe('Does the thing.')
    })

    it('does not swallow source lines between an earlier block comment and a trailing one', () => {
      // The line above the symbol ends with `*/` because it carries a trailing comment, not because
      // it closes a doc block: everything between it and the file's license header is code.
      const lines = [
        '/* Copyright 2026 Example Corp.',
        '   All rights reserved. */',
        'static const char *SECRET = "hunter2";',
        'int cached = compute(); /* cached */',
        'int my_function(void) {',
      ]
      expect(precedingDocComment(lines, 5, 'c')).toBe('')
    })

    it('does not reach past a closed block comment to an earlier one', () => {
      const lines = ['/* first block */', 'int x;', '/* second block */', 'int y;', '/* third */', 'void g() {}']
      expect(precedingDocComment(lines, 6, 'c')).toBe('third')
    })

    it('returns nothing when the closing marker has no opener above it', () => {
      const lines = ['int x = 1; */', 'void g() {}']
      expect(precedingDocComment(lines, 2, 'c')).toBe('')
    })

    it('tolerates trailing whitespace after the closing marker', () => {
      const lines = ['/* Does the thing. */  ', 'function f() {}']
      expect(precedingDocComment(lines, 2, 'c')).toBe('Does the thing.')
    })
  })

  describe("'c' style line comments", () => {
    it('collects a contiguous run of // comments, including /// and //!', () => {
      const lines = ['int x;', '/// Line one.', '//! Line two.', '// Line three.', 'fn f() {}']
      expect(precedingDocComment(lines, 5, 'c')).toBe('Line one.\nLine two.\nLine three.')
    })

    it('stops at the first non-comment line above', () => {
      const lines = ['// not mine', 'int x;', '// mine', 'void g() {}']
      expect(precedingDocComment(lines, 4, 'c')).toBe('mine')
    })
  })

  describe("'hash' style", () => {
    it('collects a contiguous run of # comments', () => {
      const lines = ['x = 1', '# Line one.', '# Line two.', 'def f():']
      expect(precedingDocComment(lines, 4, 'hash')).toBe('Line one.\nLine two.')
    })

    it('returns nothing when the line above is not a comment', () => {
      const lines = ['# far above', 'x = 1', 'def f():']
      expect(precedingDocComment(lines, 3, 'hash')).toBe('')
    })
  })

  describe('bounds', () => {
    it('returns nothing for the first line of a file', () => {
      expect(precedingDocComment(['function f() {}'], 1, 'c')).toBe('')
    })

    it('returns nothing for a line past the end of the array', () => {
      expect(precedingDocComment(['// doc'], 99, 'c')).toBe('')
    })
  })
})
