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
