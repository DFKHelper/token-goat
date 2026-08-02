/**
 * Coverage for {@link precedingDocComment} and the extractors that now use it (`makeSymbol`,
 * `extractTsJsSymbols`, `extractRustSymbols`, `extractGoSymbols`, `extractJavaSymbols`,
 * `extractCppSymbols`, `extractRubySymbols`, `extractWithRegex`) to populate
 * `SymbolEntry.docstring` from a leading comment block. Before this change, Python's
 * `pythonDocstring` was the ONLY extractor that ever set `docstring` to anything but `''` --
 * every other language's `skeleton`/`outline`/`read --stats` annotation reported
 * "undocumented" unconditionally, including this repo's own densely-docblocked TypeScript.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { extractWithRegex, parseFile, precedingDocComment } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parser-docstring-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

describe('precedingDocComment', () => {
  it('captures a c-style block comment (/** ... */) immediately above lineStart', () => {
    const lines = ['/**', ' * Adds two numbers.', ' * @returns the sum', ' */', 'function add(a, b) {']
    // 'function add...' is line 5 (1-indexed).
    expect(precedingDocComment(lines, 5, 'c')).toBe('Adds two numbers.\n@returns the sum')
  })

  it('captures a contiguous run of c-style // line comments immediately above lineStart', () => {
    const lines = ['// Adds two numbers.', '// Returns the sum.', 'function add(a, b) {']
    expect(precedingDocComment(lines, 3, 'c')).toBe('Adds two numbers.\nReturns the sum.')
  })

  it('captures a contiguous run of Rust /// doc-comment lines', () => {
    const lines = ['/// Adds two numbers.', '/// Returns the sum.', 'fn add(a: i32, b: i32) -> i32 {']
    expect(precedingDocComment(lines, 3, 'c')).toBe('Adds two numbers.\nReturns the sum.')
  })

  it('captures a contiguous run of hash (#) comment lines', () => {
    const lines = ['# Adds two numbers.', '# Returns the sum.', 'def add(a, b):']
    expect(precedingDocComment(lines, 3, 'hash')).toBe('Adds two numbers.\nReturns the sum.')
  })

  it('returns "" when there is no comment directly above lineStart', () => {
    const lines = ['x = 1', 'def add(a, b):']
    expect(precedingDocComment(lines, 2, 'hash')).toBe('')
  })

  it('ADJACENCY GUARD: returns "" when a blank line separates the comment block from lineStart (c-style)', () => {
    const lines = ['/**', ' * File header, not this symbol.', ' */', '', 'function add(a, b) {']
    // 'function add...' is line 5; line 4 (directly above) is blank.
    expect(precedingDocComment(lines, 5, 'c')).toBe('')
  })

  it('ADJACENCY GUARD: returns "" when a blank line separates a hash comment block from lineStart', () => {
    const lines = ['# File header, not this symbol.', '', 'def add(a, b):']
    expect(precedingDocComment(lines, 3, 'hash')).toBe('')
  })

  it('ADJACENCY GUARD: never attaches the same comment block to two different symbols (each walk stops at its own lineStart)', () => {
    const lines = ['/** Shared-looking header. */', 'function first() {}', 'function second() {}']
    // first() (line 2) sees the comment directly above it.
    expect(precedingDocComment(lines, 2, 'c')).toContain('Shared-looking header.')
    // second() (line 3) has `function first() {}` directly above it, not a comment -- the same
    // block must not leak forward onto it.
    expect(precedingDocComment(lines, 3, 'c')).toBe('')
  })
})

describe('extractTsJsSymbols docstring population', () => {
  it('populates docstring for an exported function with a leading /** */ block', async () => {
    const file = write(
      'a.ts',
      ['/**', ' * Adds two numbers.', ' */', 'export function add(a: number, b: number): number {', '  return a + b', '}', ''].join(
        '\n',
      ),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toContain('Adds two numbers.')
  })

  it('populates docstring for a plain (non-exported) function', async () => {
    const file = write(
      'b.ts',
      ['// Internal helper.', 'function helper(): void {}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'helper')
    expect(sym?.docstring).toBe('Internal helper.')
  })

  it('populates docstring for a class', async () => {
    const file = write(
      'c.ts',
      ['/**', ' * Represents a widget.', ' */', 'export class Widget {', '  x = 1', '}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'Widget' && s.kind === 'class')
    expect(sym?.docstring).toContain('Represents a widget.')
  })

  it('populates docstring for a class method', async () => {
    const file = write(
      'd.ts',
      [
        'export class Widget {',
        '  /**',
        '   * Computes the area.',
        '   */',
        '  area(): number {',
        '    return 1',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'area' && s.kind === 'method')
    expect(sym?.docstring).toContain('Computes the area.')
  })

  it('populates docstring for an exported arrow function bound to a const', async () => {
    const file = write(
      'e.ts',
      ['/** Doubles a number. */', 'export const double = (x: number): number => x * 2', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'double' && s.kind === 'function')
    expect(sym?.docstring).toContain('Doubles a number.')
  })

  it('looks above a decorator line to find the doc comment (skips the decorator itself)', async () => {
    const file = write(
      'f.ts',
      [
        '/**',
        ' * Marks a route handler.',
        ' */',
        '@Controller()',
        'export class MyController {}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'MyController')
    expect(sym?.docstring).toContain('Marks a route handler.')
  })

  it('does not attach a file-header comment separated by a blank line to the first function', async () => {
    const file = write(
      'g.ts',
      ['/**', ' * File header, unrelated to the function below.', ' */', '', 'export function noDoc(): void {}', ''].join(
        '\n',
      ),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'noDoc')
    expect(sym?.docstring).toBe('')
  })
})

describe('extractRustSymbols docstring population', () => {
  it('populates docstring for a function with a leading /// doc-comment run', async () => {
    const file = write(
      'a.rs',
      ['/// Adds two numbers.', '/// Returns the sum.', 'fn add(a: i32, b: i32) -> i32 {', '    a + b', '}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toBe('Adds two numbers.\nReturns the sum.')
  })

  it('populates docstring for a struct with a /** */ block comment', async () => {
    const file = write(
      'b.rs',
      ['/**', ' * Represents a widget.', ' */', 'struct Widget { x: i32 }', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'Widget' && s.kind === 'struct')
    expect(sym?.docstring).toContain('Represents a widget.')
  })

  it('looks above a leading #[attribute] to find the doc comment (skips the attribute itself)', async () => {
    const file = write(
      'c.rs',
      ['/// A widget on the screen.', "#[derive(Debug)]", 'struct Widget { x: i32 }', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'Widget' && s.kind === 'struct')
    expect(sym?.docstring).toBe('A widget on the screen.')
  })

  it('does not attach a file-header comment separated by a blank line to the first item', async () => {
    const file = write(
      'd.rs',
      ['//! File-level header, unrelated to the fn below.', '', 'fn noDoc() {}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'noDoc')
    expect(sym?.docstring).toBe('')
  })
})

describe('extractGoSymbols docstring population', () => {
  it('populates docstring for a func with a leading // doc-comment run', async () => {
    const file = write(
      'a.go',
      [
        'package main',
        '',
        '// Add adds two numbers.',
        '// It returns their sum.',
        'func Add(a, b int) int {',
        '\treturn a + b',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'Add')
    expect(sym?.docstring).toBe('Add adds two numbers.\nIt returns their sum.')
  })

  it('does not pick up a hash (#) comment above a func', async () => {
    const file = write(
      'e.go',
      ['package main', '', '# not a go comment', 'func NoDoc() {}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'NoDoc')
    expect(sym?.docstring).toBe('')
  })

  it('does not attach a file-header comment separated by a blank line to the first func', async () => {
    const file = write(
      'b.go',
      [
        'package main',
        '',
        '// File header, unrelated to the func below.',
        '',
        'func NoDoc() {}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'NoDoc')
    expect(sym?.docstring).toBe('')
  })
})

describe('extractJavaSymbols docstring population', () => {
  it('populates docstring for a method with a leading javadoc block', async () => {
    const file = write(
      'a.java',
      [
        'class Widget {',
        '  /**',
        '   * Computes the area.',
        '   */',
        '  int area() { return 1; }',
        '}',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'area' && s.kind === 'method')
    expect(sym?.docstring).toContain('Computes the area.')
  })

  it('populates docstring for a class with a leading javadoc block', async () => {
    const file = write(
      'b.java',
      ['/**', ' * Represents a widget.', ' */', 'class Widget {', '}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'Widget' && s.kind === 'class')
    expect(sym?.docstring).toContain('Represents a widget.')
  })

  it('does not pick up a hash (#) comment above a class', async () => {
    const file = write('e.java', ['# not a java comment', 'class NoDoc {', '}', ''].join('\n'))
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'NoDoc')
    expect(sym?.docstring).toBe('')
  })

  it('does not attach a file-header comment separated by a blank line to the first class', async () => {
    const file = write(
      'c.java',
      ['/**', ' * File header, unrelated to the class below.', ' */', '', 'class NoDoc {', '}', ''].join(
        '\n',
      ),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'NoDoc')
    expect(sym?.docstring).toBe('')
  })
})

describe('extractCppSymbols docstring population', () => {
  it('populates docstring for a function with a leading /** */ block', async () => {
    const file = write(
      'a.c',
      ['/**', ' * Adds two numbers.', ' */', 'int add(int a, int b) {', '  return a + b;', '}', ''].join(
        '\n',
      ),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toContain('Adds two numbers.')
  })

  it('populates docstring for a function with a leading // comment run', async () => {
    const file = write(
      'b.c',
      ['// Adds two numbers.', 'int add(int a, int b) {', '  return a + b;', '}', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toBe('Adds two numbers.')
  })

  it('does not pick up a hash (#) comment above a function', async () => {
    const file = write(
      'e.c',
      ['# not a c comment', 'int noDoc(void) { return 0; }', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'noDoc')
    expect(sym?.docstring).toBe('')
  })

  it('does not attach a file-header comment separated by a blank line to the first function', async () => {
    const file = write(
      'c.c',
      [
        '/**',
        ' * File header, unrelated to the function below.',
        ' */',
        '',
        'int noDoc(void) { return 0; }',
        '',
      ].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'noDoc')
    expect(sym?.docstring).toBe('')
  })
})

describe('extractRubySymbols docstring population', () => {
  it('populates docstring for a def with a leading # comment run', async () => {
    const file = write(
      'a.rb',
      ['# Adds two numbers.', '# Returns the sum.', 'def add(a, b)', '  a + b', 'end', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toBe('Adds two numbers.\nReturns the sum.')
  })

  it('populates docstring for a class with a leading # comment run', async () => {
    const file = write(
      'b.rb',
      ['# Represents a widget.', 'class Widget', 'end', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'Widget' && s.kind === 'class')
    expect(sym?.docstring).toBe('Represents a widget.')
  })

  it('does not pick up a // comment above a def (Ruby uses hash style, not c style)', async () => {
    const file = write(
      'e.rb',
      ['// not a ruby comment', 'def no_doc', 'end', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'no_doc')
    expect(sym?.docstring).toBe('')
  })

  it('does not attach a file-header comment separated by a blank line to the first def', async () => {
    const file = write(
      'c.rb',
      ['# File header, unrelated to the def below.', '', 'def no_doc', 'end', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'no_doc')
    expect(sym?.docstring).toBe('')
  })
})

describe('extractWithRegex (fallback) docstring population', () => {
  // extractWithRegex only actually runs in production for an unrecognized filename/extension
  // (where detectLanguage returns 'unknown' -- but extractSymbolsNoTreeSitter short-circuits to
  // `[]` for 'unknown' before ever reaching it) or as the safety net when a tree-sitter grammar
  // throws mid-parse on a real language's source, which isn't practical to force deterministically
  // through `parseFile` in a unit test. Called directly here instead (it's exported for this
  // reason) -- each FALLBACK_PATTERNS entry carries its own `style`, since the function has no
  // reliable `Language` to key off at the point it runs.
  it('populates docstring for a Python-shaped def (hash style)', () => {
    const content = ['# Adds two numbers.', 'def add(a, b):', '    return a + b', ''].join('\n')
    const symbols = extractWithRegex(content, 'irrelevant.path')
    const sym = symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toBe('Adds two numbers.')
  })

  it('populates docstring for a Rust/Go-shaped fn (c style)', () => {
    const content = ['// Adds two numbers.', 'fn add(a: i32, b: i32) -> i32 {', '    a + b', '}', ''].join('\n')
    const symbols = extractWithRegex(content, 'irrelevant.path')
    const sym = symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toBe('Adds two numbers.')
  })

  it('does not attach a file-header comment separated by a blank line to the first regex-matched symbol', () => {
    const content = ['# File header, unrelated.', '', 'def noDoc():', '    pass', ''].join('\n')
    const symbols = extractWithRegex(content, 'irrelevant.path')
    const sym = symbols.find((s) => s.name === 'noDoc')
    expect(sym?.docstring).toBe('')
  })
})

describe('existing Python docstring extraction (unchanged)', () => {
  it('still extracts a function docstring from its body (pythonDocstring, untouched by this change)', async () => {
    const file = write(
      'a.py',
      ['def add(a, b):', '    """Adds two numbers."""', '    return a + b', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'add')
    expect(sym?.docstring).toBe('Adds two numbers.')
  })

  it('still extracts a class docstring from its body', async () => {
    const file = write(
      'b.py',
      ['class Widget:', '    """Represents a widget."""', '    def __init__(self):', '        pass', ''].join('\n'),
    )
    const result = await parseFile(file)
    const sym = result.symbols.find((s) => s.name === 'Widget' && s.kind === 'class')
    expect(sym?.docstring).toBe('Represents a widget.')
  })
})
