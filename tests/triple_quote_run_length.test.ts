import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

// A quote run longer than the delimiter used to mis-pair. Both halves of the brace walk and the line-by-line masker paired a triple-quoted literal with a plain `indexOf` of the delimiter, which finds the FIRST three quotes of a four-quote run and leaves the fourth behind as code. That stray quote either opened a string that swallowed the rest of the file (spans collapse to the signature line) or blanked the rest of its own line (a declaration sharing the line disappears). The rule is per language, so one fix could not be applied uniformly: Kotlin and Scala take the LAST three quotes of a trailing run, Dart takes the FIRST three and treats the remainder as code, and C# takes the whole closing run with the length set by the opener.
//
// Every span below is HAND-DERIVED: each expected `[name, lineStart, lineEnd]` triple is read off the fixture text by counting its lines, not captured from the parser.

const spansOf = (symbols: readonly { name: string; lineStart: number; lineEnd: number }[]): [string, number, number][] =>
  symbols.map((s) => [s.name, s.lineStart, s.lineEnd])

describe('Kotlin takes the last three quotes of a trailing run', () => {
  // Fixture provenance: FORMAT-DERIVED. `"""a""""` is the string `a"` per the Kotlin language specification, "Expressions", section "String literals" (multiline string literals), which pairs the closing delimiter with the last three quotes of a trailing run.
  it('keeps the class span across a raw string ending in a quote', async () => {
    const content = [
      'class A',
      '{',
      '    val s = """a""""',
      '    fun one(): Int = 1',
      '}',
      '',
      'class B',
      '{',
      '    fun two(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Trailing.kt', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 5],
      ['one', 4, 4],
      ['B', 7, 10],
      ['two', 9, 9],
    ])
  })

  it('keeps a declaration that shares the line after the raw string', async () => {
    const content = [
      'class A {',
      '    val s = """x""""; val t = if (true) {',
      '        1',
      '    } else {',
      '        2',
      '    }',
      '',
      '    fun one(): Int = 1',
      '}',
      '',
      'class B {',
      '    fun two(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Sharing.kt', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 9],
      ['one', 8, 8],
      ['B', 11, 13],
      ['two', 12, 12],
    ])
  })

  // Negative control: an ordinary raw string with no trailing run. The run-length rule must leave this exactly as it was, so this case passes both before and after the fix.
  it('leaves an ordinary raw string alone', async () => {
    const content = [
      'class A',
      '{',
      '    val s = """a"""',
      '    fun one(): Int = 1',
      '}',
      '',
      'class B',
      '{',
      '    fun two(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Plain.kt', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 5],
      ['one', 4, 4],
      ['B', 7, 10],
      ['two', 9, 9],
    ])
  })

  // Loss-direction probe: widening the masked span must not blank a name out of the code around it. Every declaration the file really makes still has to be extracted.
  it('still finds every declaration around the trailing run', async () => {
    const content = [
      'class Alpha {',
      '    fun before(): Int = 1',
      '    val doc = """note""""',
      '    fun after(): Int = 2',
      '}',
      '',
      'fun topLevel(): Int = 3',
      '',
    ].join('\n')
    const result = await parseFixture('Probe.kt', content)
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['Alpha', 'after', 'before', 'topLevel'])
  })
})

describe('Scala takes the last three quotes of a trailing run', () => {
  // Fixture provenance: FORMAT-DERIVED. The Scala language specification, section 1.3.5 "Character Literals and String Literals", states that a multi-line string literal is terminated by the last three of a run of three or more quotes, so `"""a""""` is the string `a"`.
  it('keeps the class span across a raw string ending in a quote', async () => {
    const content = [
      'class A',
      '{',
      '  val s = """a""""',
      '  def one(): Int = 1',
      '}',
      '',
      'class B',
      '{',
      '  def two(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Trailing.scala', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 5],
      ['s', 3, 3],
      ['one', 4, 4],
      ['B', 7, 10],
      ['two', 9, 9],
    ])
  })

  // Negative control: identical shape with an ordinary closing delimiter.
  it('leaves an ordinary raw string alone', async () => {
    const content = [
      'class A',
      '{',
      '  val s = """a"""',
      '  def one(): Int = 1',
      '}',
      '',
      'class B',
      '{',
      '  def two(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Plain.scala', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 5],
      ['s', 3, 3],
      ['one', 4, 4],
      ['B', 7, 10],
      ['two', 9, 9],
    ])
  })

  // Loss-direction probe.
  it('still finds every declaration around the trailing run', async () => {
    const content = [
      'class Alpha {',
      '  def before(): Int = 1',
      '  val doc = """note""""',
      '  def after(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Probe.scala', content)
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['Alpha', 'after', 'before', 'doc'])
  })
})

describe('Dart takes the first three quotes of a longer run', () => {
  // Fixture provenance: FORMAT-DERIVED. The Dart Programming Language Specification, section "Strings", gives the multi-line string production as the delimiter, a repetition of a content production that excludes the delimiter, then the delimiter, so the literal ends at the first complete run; the same section makes adjacent string literals concatenate, so `'''a''''''b'''` is two literals in a row spelling `ab`, not one literal with a four-quote closer.
  it('reads a six-quote run as one literal closing and the next opening', async () => {
    const content = [
      "var s = '''",
      "a''''''b''';",
      '',
      'class A {',
      '  int one() {',
      '    return 1;',
      '  }',
      '}',
      '',
      'class B {',
      '  int two() {',
      '    return 2;',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('trailing.dart', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 4, 8],
      ['one', 5, 7],
      ['B', 10, 14],
      ['two', 11, 13],
    ])
  })

  it('reads the same run on a single line as two literals', async () => {
    const content = [
      'class A {',
      "  String get s => '''a''''''b''';",
      '',
      '  int one() {',
      '    return 1;',
      '  }',
      '}',
      '',
      'class B {',
      '  int two() {',
      '    return 2;',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('adjacent.dart', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 7],
      ['s', 2, 2],
      ['one', 4, 6],
      ['B', 9, 13],
      ['two', 10, 12],
    ])
  })

  // Negative control: one ordinary multi-line string, no run longer than the delimiter.
  it('leaves an ordinary multi-line string alone', async () => {
    const content = [
      "var s = '''",
      "ab''';",
      '',
      'class A {',
      '  int one() {',
      '    return 1;',
      '  }',
      '}',
      '',
      'class B {',
      '  int two() {',
      '    return 2;',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('plain.dart', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 4, 8],
      ['one', 5, 7],
      ['B', 10, 14],
      ['two', 11, 13],
    ])
  })

  // Loss-direction probe.
  it('still finds every declaration around the longer run', async () => {
    const content = [
      'class Alpha {',
      '  int before() {',
      '    return 1;',
      '  }',
      '',
      "  String get doc => '''a''''''b''';",
      '',
      '  int after() {',
      '    return 2;',
      '  }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('probe.dart', content)
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['Alpha', 'after', 'before', 'doc'])
  })
})

describe('C# takes the whole closing run at the length its opener declared', () => {
  // Fixture provenance: FORMAT-DERIVED. The C# language reference, "Raw string literals", specifies that the delimiter is a run of three or more quotes whose length is set by the opening run, which is how a literal that itself contains three quotes is written. The four-quote opener below therefore is not closed by the interior `"""` runs.
  it('keeps the class span across a four-quote raw string holding three-quote runs', async () => {
    const content = [
      'class A',
      '{',
      '    const string S = """"say """hi""" now"""";',
      '',
      '    int One() { return 1; }',
      '}',
      '',
      'class B',
      '{',
      '    int Two() { return 2; }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Trailing.cs', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 6],
      ['One', 5, 5],
      ['B', 8, 11],
      ['Two', 10, 10],
    ])
  })

  // Negative control: an ordinary three-quote raw string.
  it('leaves an ordinary three-quote raw string alone', async () => {
    const content = [
      'class A',
      '{',
      '    const string S = """say hi now""";',
      '',
      '    int One() { return 1; }',
      '}',
      '',
      'class B',
      '{',
      '    int Two() { return 2; }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Plain.cs', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 6],
      ['One', 5, 5],
      ['B', 8, 11],
      ['Two', 10, 10],
    ])
  })

  // Loss-direction probe.
  it('still finds every declaration around the four-quote literal', async () => {
    const content = [
      'class Alpha',
      '{',
      '    int Before() { return 1; }',
      '',
      '    const string Doc = """"note"""";',
      '',
      '    int After() { return 2; }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Probe.cs', content)
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['After', 'Alpha', 'Before'])
  })
})
