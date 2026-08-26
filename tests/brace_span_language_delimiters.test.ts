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
