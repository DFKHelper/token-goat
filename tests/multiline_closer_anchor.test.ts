import { describe, it, expect } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

// Two languages require their multi-line closing delimiter to begin its own line, and the closer search matched one anywhere on the line. A `"""` sitting mid-line inside an Elixir heredoc or a Swift multi-line string ended the literal there, so the rest of the body was parsed as ordinary source: the file's real declarations below the literal vanished and declarations written as example text INSIDE it were extracted as if the file made them. Each case below therefore asserts the invented name is absent as well as asserting the real spans.
//
// Every span is HAND-DERIVED: each expected `[name, lineStart, lineEnd]` triple is read off the fixture text by counting its lines, not captured from the parser.

const spansOf = (symbols: readonly { name: string; lineStart: number; lineEnd: number }[]): [string, number, number][] =>
  symbols.map((s) => [s.name, s.lineStart, s.lineEnd])

const namesOf = (symbols: readonly { name: string }[]): string[] => symbols.map((s) => s.name).sort()

describe('an Elixir heredoc closes only on a delimiter that begins a line', () => {
  // Fixture provenance: FORMAT-DERIVED. The Elixir syntax reference, section "Strings", states that a heredoc opened with `"""` runs until a `"""` that begins a line, preceded by nothing but the whitespace that also sets the indentation stripped from the body, so a `"""` appearing mid-line is ordinary content.
  it('reads a mid-line delimiter as body text rather than the closer', async () => {
    const content = [
      'defmodule Sample do',
      '  @moduledoc """',
      '  Example: a literal """ appears mid-line.',
      '  def ghost(x), do: x',
      '  """',
      '',
      '  def alpha(x), do: x + 1',
      'end',
      '',
    ].join('\n')
    const result = await parseFixture('sample.ex', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Sample', 1, 8],
      ['alpha', 7, 7],
    ])
    // `ghost` is written inside the heredoc. The file declares no such function, so extracting it would be a fabrication, which is worse than missing `alpha`.
    expect(namesOf(result.symbols)).not.toContain('ghost')
  })

  it('accepts a deeply indented closer', async () => {
    const content = [
      'defmodule Sample do',
      '  def alpha(x) do',
      '    doc = """',
      '    text """ still body',
      '        """',
      '',
      '    doc <> x',
      '  end',
      'end',
      '',
    ].join('\n')
    const result = await parseFixture('indented.ex', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Sample', 1, 9],
      ['alpha', 2, 8],
    ])
    expect(namesOf(result.symbols)).not.toContain('doc')
  })

  // Negative control: the same shape with an ordinary closer and no mid-line delimiter. Anchoring must leave this exactly as it was, so it passes both before and after the fix.
  it('leaves an ordinary heredoc alone', async () => {
    const content = [
      'defmodule Sample do',
      '  @moduledoc """',
      '  Example text with no delimiter in it.',
      '  """',
      '',
      '  def alpha(x), do: x + 1',
      'end',
      '',
    ].join('\n')
    const result = await parseFixture('plain.ex', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Sample', 1, 7],
      ['alpha', 6, 6],
    ])
  })

  // Loss-direction probe: anchoring the closer widens the masked span, so every declaration the file really makes still has to come back.
  it('still finds every declaration around the heredoc', async () => {
    const content = [
      'defmodule Alpha do',
      '  def before_it(x), do: x',
      '',
      '  @doc """',
      '  note with """ inside',
      '  """',
      '  def after_it(x), do: x',
      'end',
      '',
    ].join('\n')
    const result = await parseFixture('probe.ex', content)
    expect(namesOf(result.symbols)).toEqual(['Alpha', 'after_it', 'before_it'])
  })
})

describe('a Swift multi-line string closes only on a delimiter that begins a line', () => {
  // Fixture provenance: FORMAT-DERIVED. The Swift Programming Language, "Strings and Characters", section "Multiline String Literals", states that the closing delimiter appears on a line of its own and that its indentation sets what is stripped from each body line. The body below writes its three quotes as `\"""` so the line is unambiguously legal Swift regardless of that rule.
  it('reads a mid-line delimiter as body text rather than the closer', async () => {
    const content = [
      'struct Sample {',
      '    let doc = """',
      '    Example: a literal \\""" appears mid-line.',
      '    func ghost() -> Int { return 0 }',
      '    """',
      '    func alpha() -> Int { return 1 }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Sample.swift', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Sample', 1, 7],
      ['doc', 2, 2],
      ['alpha', 6, 6],
    ])
    expect(namesOf(result.symbols)).not.toContain('ghost')
  })

  it('accepts a deeply indented closer', async () => {
    const content = [
      'struct Sample {',
      '    func alpha() -> Int {',
      '        let doc = """',
      '        text \\""" still body',
      '            """',
      '        return doc.count',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Indented.swift', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Sample', 1, 8],
      ['alpha', 2, 7],
    ])
  })

  // Fixture provenance: FORMAT-DERIVED. The same chapter's section "Extended String Delimiters" gives the `#"""..."""#` form, whose closing delimiter is the quote run followed by the opener's own hash run; it is a multi-line string literal, so the closing-delimiter placement rule above applies to it too.
  it('reads a mid-line extended delimiter as body text rather than the closer', async () => {
    const content = [
      'struct Sample {',
      '    let doc = #"""',
      '    Example: a literal """# appears mid-line.',
      '    func ghost() -> Int { return 0 }',
      '    """#',
      '    func alpha() -> Int { return 1 }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Extended.swift', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Sample', 1, 7],
      ['doc', 2, 2],
      ['alpha', 6, 6],
    ])
    expect(namesOf(result.symbols)).not.toContain('ghost')
  })

  // Negative control.
  it('leaves an ordinary multi-line string alone', async () => {
    const content = [
      'struct Sample {',
      '    let doc = """',
      '    Example text with no delimiter in it.',
      '    """',
      '    func alpha() -> Int { return 1 }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Plain.swift', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Sample', 1, 6],
      ['doc', 2, 2],
      ['alpha', 5, 5],
    ])
  })

  // Loss-direction probe.
  it('still finds every declaration around the multi-line string', async () => {
    const content = [
      'struct Alpha {',
      '    func beforeIt() -> Int { return 1 }',
      '    let doc = """',
      '    note with \\""" inside',
      '    """',
      '    func afterIt() -> Int { return 2 }',
      '}',
      '',
      'func topLevel() -> Int { return 3 }',
      '',
    ].join('\n')
    const result = await parseFixture('Probe.swift', content)
    expect(namesOf(result.symbols)).toEqual(['Alpha', 'afterIt', 'beforeIt', 'doc', 'topLevel'])
  })
})

describe('languages whose closer has no positional rule keep matching it anywhere', () => {
  // Fixture provenance: FORMAT-DERIVED. The Kotlin language specification, "Expressions", section "String literals", terminates a multiline string literal at the next `"""` with no rule about where on a line it falls, so the mid-line delimiter below closes the literal and `+ "x"` after it is code. Anchoring Kotlin would leave this literal open to end of file and lose every declaration below it.
  it('closes a Kotlin raw string on a mid-line delimiter', async () => {
    const content = [
      'class A {',
      '    val s = """',
      '    text """ + "x"',
      '    fun one(): Int = 1',
      '}',
      '',
      'class B {',
      '    fun two(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Midline.kt', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 5],
      ['one', 4, 4],
      ['B', 7, 9],
      ['two', 8, 8],
    ])
  })

  // Fixture provenance: FORMAT-DERIVED. The Scala language specification, section 1.3.5 "Character Literals and String Literals", terminates a multi-line string literal at the next run of three quotes, with no positional rule.
  it('closes a Scala multi-line string on a mid-line delimiter', async () => {
    const content = [
      'class A',
      '{',
      '  val s = """',
      '  text """ + "b"',
      '  def one(): Int = 1',
      '}',
      '',
      'class B',
      '{',
      '  def two(): Int = 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('Midline.scala', content)
    expect(spansOf(result.symbols)).toEqual([
      ['A', 1, 6],
      ['s', 3, 3],
      ['one', 5, 5],
      ['B', 8, 11],
      ['two', 10, 10],
    ])
  })

  // Fixture provenance: FORMAT-DERIVED. The R base help page `?Quotes`, "Raw character constants", closes a raw constant on its mirrored punctuation and the same quote, wherever that falls on a line.
  it('closes an R raw constant on a mid-line delimiter', async () => {
    const content = [
      'setClass("Point", representation(x = "numeric"))',
      '',
      'txt <- r"(',
      'one )" ; two <- 2',
      '',
      'alpha <- function(a) {',
      '  a + 1',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('midline.R', content)
    expect(namesOf(result.symbols)).toContain('alpha')
  })
})

describe('a closer that has to begin its line keeps doing so', () => {
  // Fixture provenance: FORMAT-DERIVED. PowerShell about_Quoting_Rules, section "Here-Strings", requires the `"@` terminator to be the first characters on its line, so the indented one on line 4 below is body text and only the one at column zero ends the here-string. This is the one language here stricter than "only whitespace may precede it".
  it('ignores an indented PowerShell here-string terminator', async () => {
    const content = [
      'function Get-Alpha {',
      '    $text = @"',
      'line one',
      '    "@ not a terminator',
      '"@',
      '    return $text',
      '}',
      '',
      'function Get-Beta {',
      '    return 2',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('here.ps1', content)
    expect(spansOf(result.symbols)).toEqual([
      ['Get-Alpha', 1, 7],
      ['Get-Beta', 9, 11],
    ])
  })

  // Fixture provenance: FORMAT-DERIVED. The PHP language reference, "Strings", section "Heredoc text", allows the closing identifier to be indented as of PHP 7.3 and to be followed by other characters such as the statement's semicolon.
  it('accepts an indented PHP heredoc closer', async () => {
    const content = [
      '<?php',
      'class Sample {',
      '    public function alpha() {',
      '        $t = <<<EOT',
      '        body text',
      '        EOT;',
      '        return $t;',
      '    }',
      '',
      '    public function beta() {',
      '        return 2;',
      '    }',
      '}',
      '',
    ].join('\n')
    const result = await parseFixture('sample.php', content)
    expect(namesOf(result.symbols)).toEqual(['Sample', 'alpha', 'beta'])
  })
})
