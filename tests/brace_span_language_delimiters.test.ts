import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

// The brace walk used to derive its block-comment delimiters from the line-comment prefix: any language spelling line comments `//` was assumed to spell block comments `/* */`. Zig spells line comments `//` but has no block comment at all, so an ordinary `a/*b` (divide, then pointer dereference) opened a comment the scan never found a closer for. skipBlockComment returned -1, findBlockOpenBrace bailed, and the function kept its one-line signature span.
describe('brace span scanning respects a language without block comments', () => {
  it('keeps a Zig function span when a divide is followed by a dereference', async () => {
    const content = [
      'pub fn f(a: i32, b: i32) i32 {',
      '    return a/*b;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('div.zig', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(1)
    expect(f?.lineEnd).toBe(3)
    expect(f?.body).toContain('return a/*b;')
  })

  it('still skips a real block comment in a language that has one', async () => {
    const content = [
      '<?php',
      'function f() {',
      '  /* } */',
      '  return 1;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('block.php', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(2)
    expect(f?.lineEnd).toBe(5)
    expect(f?.body).toContain('return 1;')
  })
})

// Zig writes a multi-line string as a `\\` at the start of each line, running to end of line with no closing delimiter and no escape sequences. The brace walk read those lines as code, so a `}` sitting in the text closed the enclosing function early.
describe('brace span scanning treats a Zig line-prefixed string as opaque', () => {
  it('keeps a function span across a multi-line string containing a brace', async () => {
    const content = [
      'pub fn g() void {',
      '    const t =',
      '        \\\\}',
      '        \\\\still text',
      '    ;',
      '    use(t);',
      '}',
      '',
      'pub fn h() void {',
      '    other();',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('multiline.zig', content)
    const g = result.symbols.find((s) => s.name === 'g')
    expect(g?.lineStart).toBe(1)
    expect(g?.lineEnd).toBe(7)
    expect(g?.body).toContain('use(t);')
    // The skip stops at the newline, not at end of content, so the next function is still found whole.
    const h = result.symbols.find((s) => s.name === 'h')
    expect(h?.lineStart).toBe(9)
    expect(h?.lineEnd).toBe(11)
  })

  it('still reads a backslash inside a quoted Zig string as an escape', async () => {
    const content = [
      'pub fn e() void {',
      '    const s = "a\\\\";',
      '    use(s);',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('escape.zig', content)
    const e = result.symbols.find((s) => s.name === 'e')
    expect(e?.lineStart).toBe(1)
    expect(e?.lineEnd).toBe(4)
  })
})

// PHP accepts both `//` and `#` for a line comment, but the brace walk was told about `//` only, so a brace inside a `#` comment was counted as real and the enclosing function's span stopped there. `#` is not universally a comment in PHP: `#[Attr]` is an attribute, and reading it as a comment would lose an opening brace sharing that line.
describe('brace span scanning knows both PHP line-comment spellings', () => {
  it('skips a closing brace inside a hash comment', async () => {
    const content = [
      '<?php',
      'function f() {',
      '  # }',
      '  return 1;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('hash.php', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(2)
    expect(f?.lineEnd).toBe(5)
    expect(f?.body).toContain('return 1;')
  })

  it('still reads a PHP attribute sharing the signature line as code', async () => {
    const content = [
      '<?php',
      'function f(#[SensitiveParameter] string $p) {',
      '  return $p;',
      '}',
      '',
      '#[Route(\'/x\')]',
      'function g() {',
      '  return 2;',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('attr.php', content)
    expect(result.symbols.find((s) => s.name === 'f')?.lineEnd).toBe(4)
    const g = result.symbols.find((s) => s.name === 'g')
    expect(g?.lineStart).toBe(7)
    expect(g?.lineEnd).toBe(9)
  })

  it('keeps treating a hash-bracket line as a comment in PowerShell, which has no attribute syntax there', async () => {
    const content = [
      'function f {',
      '#[note] }',
      '  Write-Output 1',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('note.ps1', content)
    const f = result.symbols.find((s) => s.name === 'f')
    expect(f?.lineStart).toBe(1)
    expect(f?.lineEnd).toBe(4)
  })
})
