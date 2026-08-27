import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

import type { SymbolEntry } from '../src/parser_types.js'

// findBlockOpenBrace scans forward from a symbol's declaration line for the `{` that opens its body, and stopped only at a `;` or at a block-opening control keyword. It never stopped at a `}`, so a brace-less declaration whose parent block ends on the very next line kept scanning past that closer and latched onto the first `{` below it. assignBraceBlockSpans only caps the window at the next KNOWN symbol start, so any unindexed brace construct in between is fair game: Scala's `val timeout = 30` as the last member of an object recorded a span that ran through the object's own `}` and swallowed a following `locally { ... }` block whole.
const pin = (symbols: readonly SymbolEntry[]): unknown[][] =>
  [...symbols]
    .sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name))
    .map((s) => [s.name, s.kind, s.parent ?? '', s.lineStart, s.lineEnd])

describe('the brace-open search stops at a closing brace', () => {
  it('keeps a Scala val at one line when an unindexed brace block follows its object', async () => {
    const content = [
      'object Cfg {',
      '  val timeout = 30',
      '}',
      'locally {',
      '  println("side effect")',
      '}',
      'object Other {',
      '  val n = 1',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('cfg.scala', content)
    expect(pin(result.symbols)).toEqual([
      ['Cfg', 'object', '', 1, 3],
      ['timeout', 'val', 'Cfg', 2, 2],
      ['Other', 'object', '', 7, 9],
      ['n', 'val', 'Other', 8, 8],
    ])
  })

  // The control: a declaration whose body brace really does sit on a later line must still find it, so the new stop must not fire before the opening brace of a legitimate multi-line signature.
  it('still spans a Scala def whose opening brace is on a continuation line', async () => {
    const content = [
      'object Cfg {',
      '  def add(',
      '    a: Int,',
      '    b: Int,',
      '  ): Int = {',
      '    a + b',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('add.scala', content)
    expect(pin(result.symbols)).toEqual([
      ['Cfg', 'object', '', 1, 8],
      ['add', 'function', 'Cfg', 2, 7],
    ])
  })

  // The second control: a `}` inside a string literal is not a block closer, so the stop has to sit after the string/comment masking rather than on the raw text. Allman-brace C# is the shape that reaches findBlockOpenBrace for a body brace one line below the signature, so a stop that fires on the quoted `}` collapses the method to its signature line.
  it('ignores a closing brace inside a C# default-argument string', async () => {
    const content = [
      'class A',
      '{',
      '    public string M(string s = "}")',
      '    {',
      '        return s;',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('b.cs', content)
    expect(pin(result.symbols)).toEqual([
      ['A', 'class', '', 1, 7],
      ['M', 'method', 'A', 3, 6],
    ])
  })

  // The same control in a language whose members carry no `;`, where the quoted `}` also sits inside a parameter list: the bracket-depth guard and the string masking both have to hold for the def to keep its real body.
  it('ignores a closing brace inside a Scala default-argument string', async () => {
    const content = [
      'object Cfg {',
      '  def tag(sep: String = "}",',
      '          n: Int = 1): String = {',
      '    sep * n',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('d.scala', content)
    expect(pin(result.symbols)).toEqual([
      ['Cfg', 'object', '', 1, 6],
      ['tag', 'function', 'Cfg', 2, 5],
    ])
  })
})
