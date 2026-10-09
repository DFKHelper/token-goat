/** A Scala symbol literal (`'sym`) has no closing quote, so a scanner that read every `'` as a string opener went on treating the rest of the file as string text: a later block comment holding a quote or a class's closing brace was lost, dropping members and truncating the class span. These go through the real parseFile. */
import { describe, expect, it } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

async function spans(content: string): Promise<string[]> {
  const { symbols } = await parseFixture('Sym.scala', content)
  return [...symbols].sort((a, b) => a.lineStart - b.lineStart).map((s) => `${s.name} ${s.lineStart}-${s.lineEnd}`)
}

describe('parseFile on Scala: a symbol literal does not open a string', () => {
  // HAND-DERIVED: spans read off each fixture by hand.
  it('indexes the member after a symbol literal and a block comment holding a quote', async () => {
    expect(await spans("class A { def a = 'sym; /* \" */ def b = 2 }\n")).toEqual(['A 1-1', 'a 1-1', 'b 1-1'])
  })

  it('closes the class on its own brace after a lone symbol literal', async () => {
    expect(await spans(["class A { val s = 'sym", '  def b = 2', '}', ''].join('\n'))).toEqual(['A 1-3', 's 1-1', 'b 2-2'])
  })

  // The control: a real character literal is still skipped whole, so a quote or brace inside one is text.
  it('still skips a character literal holding a quote or a brace', async () => {
    expect(await spans(["class A {", "  val q = '\"'", "  val c = '}'", '  def b = 2', '}', ''].join('\n'))).toEqual(['A 1-5', 'q 2-2', 'c 3-3', 'b 4-4'])
  })
})

// S7 as first worded (an odd quote inside a mid-line block comment flips the quote tracking) is not a defect: these pin that it holds in the brace languages.
describe('parseFile: an odd quote inside a mid-line block comment does not flip quote tracking', () => {
  // HAND-DERIVED: one function `b` on line 1 of each fixture, after a block comment holding one double quote.
  it.each([
    ['M.js', '/* " */ function b() {}\n'],
    ['M.ts', 'function a() {} /* " */ function b() {}\n'],
    ['M.java', 'class M { void a() {} /* " */ void b() {} }\n'],
    ['M.kt', 'class M { fun a() {} /* " */ fun b() {} }\n'],
    ['M.scala', 'class M { def a = 1; /* " */ def b = 2 }\n'],
  ])('%s still indexes b', async (file, content) => {
    const { symbols } = await parseFixture(file, content)
    expect(symbols.map((s) => s.name)).toContain('b')
  })
})

// The symbol/character-literal rule runs ahead of the generic quote handler, so it must never see an apostrophe that sits inside a string, a comment or an interpolation text: there it is ordinary text.
describe('parseFile on Scala: an apostrophe inside a string, a comment or an interpolation is text', () => {
  // HAND-DERIVED: each fixture is a class A with one or two members and a closing brace on its own line; the span of every line is read off the fixture by hand.
  const cases: [string, string[], string[]][] = [
    ['a string', ['class A {', '  val s = "it\'s {"', '  def b = 2', '}', ''], ['A 1-4', 's 2-2', 'b 3-3']],
    ['a string with an escaped quote', ['class A {', '  val s = "say \\"it\'s\\" {"', '  def b = 2', '}', ''], ['A 1-4', 's 2-2', 'b 3-3']],
    ['a triple-quoted string', ['class A {', '  val s = """it\'s }', '  more {"""', '  def b = 2', '}', ''], ['A 1-5', 's 2-3', 'b 4-4']],
    ['interpolation text and a character literal in the hole', ['class A {', "  val s = s\"it's ${'}'} ${x}\"", '  def b = 2', '}', ''], ['A 1-4', 's 2-2', 'b 3-3']],
    ['a symbol literal inside an interpolation hole', ['class A {', "  val s = s\"a ${ 'sym.name } it's\"", '  def b = 2', '}', ''], ['A 1-4', 's 2-2', 'b 3-3']],
    ['a line comment', ['class A {', "  // don't {", '  def b = 2', '}', ''], ['A 1-4', 'b 3-3']],
    ['a multi-line block comment', ['class A {', "  /* it's", '     a " { */', '  def b = 2', '}', ''], ['A 1-5', 'b 4-4']],
  ]
  it.each(cases)('%s', async (_what, lines, expected) => {
    expect(await spans(lines.join('\n'))).toEqual(expected)
  })
})
