import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

// Kotlin, Swift, Scala and Dart all specify block comments that nest, so `/* outer /* inner */ still outer */` is one comment. The shared brace walk ended it at the first `*/` it found, so the text after the inner closer was read as code -- and a `}` sitting there decremented the real brace depth, closing the enclosing symbol early. `outline` then reported a truncated span and `read "file::symbol"` returned a body missing its last lines.
describe('brace span scanning honours nested block comments where the language nests them', () => {
  it('keeps a Swift function span across a nested block comment holding a brace', async () => {
    const content = [
      'func first() -> Int {',
      '    /* outer /* inner */ } still outer */',
      '    return 1',
      '}',
      '',
      'func second() -> Int {',
      '    return 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('a.swift', content)
    const first = result.symbols.find((s) => s.name === 'first')
    expect(first?.lineStart).toBe(1)
    expect(first?.lineEnd).toBe(4)
    expect(first?.body).toContain('return 1')
    // The symbol after it must still be found at its real position: a span that swallowed the rest of the file would also break every sibling below.
    const second = result.symbols.find((s) => s.name === 'second')
    expect(second?.lineStart).toBe(6)
    expect(second?.lineEnd).toBe(8)
  })

  it('keeps a Kotlin function span across a nested block comment holding a brace', async () => {
    const content = [
      'fun alpha(): Int {',
      '    /* outer /* inner */ } still outer */',
      '    return 1',
      '}',
      '',
      'fun beta(): Int {',
      '    return 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('b.kt', content)
    const alpha = result.symbols.find((s) => s.name === 'alpha')
    expect(alpha?.lineStart).toBe(1)
    expect(alpha?.lineEnd).toBe(4)
    expect(alpha?.body).toContain('return 1')
  })

  it('still ends a C# block comment at its first closer, where the language does not nest', async () => {
    // The anti-over-fix control. In C# `/* a /* b */` is already closed, so `int x = 1;` after it is live code and the `}` on the next line really does end the method. Treating the inner `/*` as a nested opener would swallow that closer and stretch the span to the class brace instead.
    const content = [
      'public class Ctl',
      '{',
      '    public int M()',
      '    {',
      '        /* outer /* inner */',
      '        return 1;',
      '    }',
      '',
      '    public int N()',
      '    {',
      '        return 2;',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Ctl.cs', content)
    const m = result.symbols.find((s) => s.name === 'M')
    expect(m?.lineStart).toBe(3)
    expect(m?.lineEnd).toBe(7)
    const n = result.symbols.find((s) => s.name === 'N')
    expect(n?.lineEnd).toBe(12)
  })

  it('leaves an ordinary non-nested comment unchanged in a nesting language', async () => {
    // The second anti-over-fix control: the common case must not regress. One plain block comment carrying a brace still ends at its only closer.
    const content = [
      'func plain() -> Int {',
      '    /* just a comment with a } brace */',
      '    return 1',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('c.swift', content)
    const plain = result.symbols.find((s) => s.name === 'plain')
    expect(plain?.lineEnd).toBe(4)
    expect(plain?.body).toContain('return 1')
  })

  it('does not stretch a span to end-of-file when a nested comment is never closed', async () => {
    // `/* outer /* inner */` is unterminated in a nesting language -- the source does not compile -- so the walk finds no closing brace and assignBraceBlockSpans' noMatchValue of -1 leaves the symbol at its original one-line span rather than guessing. The nearby `func after` is not extracted at all here, but that is the comment stripper feeding the extractor and predates this change; it is not what this test pins.
    const content = [
      'func open() -> Int {',
      '    /* outer /* inner */',
      '    return 1',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('d.swift', content)
    const open = result.symbols.find((s) => s.name === 'open')
    expect(open?.lineStart).toBe(1)
    expect(open?.lineEnd, 'an unbalanced comment must not stretch the span past its own line').toBe(1)
  })
})
