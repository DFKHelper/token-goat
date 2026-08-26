import { describe, it, expect } from 'vitest'

import { stripStringLiterals } from '../src/languages/common.js'

import { parseFixture } from './helpers/parse-fixture.js'

// `stripStringLiterals` is the per-line pre-pass Dart's extractor brace-counts on, and it knew only one-character quotes. A Dart `'''...'''` literal holding an odd number of interior quotes (`'''a ' } b'''`) therefore opened and closed a string on each quote in turn, ending up OUTSIDE any string over the literal's middle -- so a `}` in that text was counted as a real closing brace. That drove the extractor's brace depth one level negative, and every later member of the class was dropped from the index outright: `token-goat symbol n` found nothing at all, with nothing to signal the method existed.
describe('stripStringLiterals and Dart triple-quoted strings', () => {
  it('keeps a later Dart method in the index when an earlier triple-quoted string holds a lone quote and a brace', async () => {
    const content = [
      'class C {',
      '  void m() {',
      "    var s = '''a ' } b''';",
      '    use(s);',
      '  }',
      '',
      '  void n() {',
      '    other();',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('d6.dart', content)
    const names = result.symbols.map((s) => s.name)
    expect(names).toContain('n')
    expect(names).toContain('m')
    expect(names).toContain('C')
  })

  it('keeps a later Dart method when the triple-double-quote spelling holds a lone quote and a brace', async () => {
    const content = [
      'class C {',
      '  void m() {',
      '    var s = """a " } b""";',
      '    use(s);',
      '  }',
      '',
      '  void n() {',
      '    other();',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('d8.dart', content)
    expect(result.symbols.map((s) => s.name)).toContain('n')
  })

  it('blanks the brace inside a triple-quoted literal only when the caller opts in', () => {
    const line = "    var s = '''a ' } b''';"
    // Pinned exactly, not just "holds no brace": blanking has to preserve every column so a caller's offsets stay aligned, and a half-fix that pops the frame on the lone interior quote can still hide the brace by overwriting it with a quote character.
    expect(stripStringLiterals(line, { tripleQuotes: true })).toBe("    var s = '''       ''';")
    expect(stripStringLiterals(line, { tripleQuotes: true })).not.toContain('}')
    // Anti-over-fix control: the default is byte-for-byte the pre-fix behaviour, so no caller that passes no options changes.
    expect(stripStringLiterals(line)).toContain('}')
  })

  it('leaves C# interpolated-string hole handling unchanged', () => {
    const line = 'var x = $"a {Foo("}")} b";'
    expect(stripStringLiterals(line, { tripleQuotes: true })).toBe(stripStringLiterals(line))
    // The hole's own braces are real code and survive; the `}` inside the nested string does not.
    expect(stripStringLiterals(line).match(/\}/g)?.length).toBe(1)
  })

  it('leaves an Apex method with an apostrophe comment unchanged', async () => {
    const content = [
      'public class Greeter {',
      '    // Don\'t break here',
      '    public void hello() {',
      '        System.debug(\'hi\');',
      '    }',
      '',
      '    public void bye() {',
      '        System.debug(\'bye\');',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Greeter.cls', content)
    expect(result.symbols.map((s) => s.name)).toContain('bye')
  })
})
