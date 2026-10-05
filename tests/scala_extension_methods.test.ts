/** Scala 3 extension methods (Scala 3 Reference, "Contextual Abstractions" > "Extension Methods", https://docs.scala-lang.org/scala3/reference/contextual/extension-methods.html) are declared behind an `extension (c: Circle)` clause, either on the clause's own line or in an indented or braced block below it. FUNC_RE is anchored at the start of the line, so the one-line form never matched, and the block form's defs sit indented under no type frame, so they were dropped too: `symbol area` found nothing for any of them. These go through the real parseFile, brace spans included. */
import { describe, expect, it } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

async function summary(content: string): Promise<string[]> {
  const { symbols } = await parseFixture('Ext.scala', content)
  return [...symbols].sort((a, b) => a.lineStart - b.lineStart).map((s) => `${s.kind} ${s.name} ${s.parent} ${s.lineStart}-${s.lineEnd}`)
}

describe('parseFile on Scala: extension methods', () => {
  // HAND-DERIVED: each layout below is one of the forms the Scala 3 Reference page cited above shows (single method on the clause line, an indented block, a type-parameter and using clause, a braced block), placed at top level and inside a braced and an indentation-syntax object.
  it('indexes the one-line form at top level, after a bodyless case class, and inside a type', async () => {
    const content = ['case class Circle(r: Double)', '', 'extension (c: Circle) def circumference: Double = c.r * 2', '', 'object Syntax {', '  extension (i: Int) def squared: Int = i * i', '  def plain(): Int = 1', '}', ''].join('\n')
    expect(await summary(content)).toEqual(['class Circle  1-1', 'function circumference  3-3', 'object Syntax  5-8', 'function squared Syntax 6-6', 'function plain Syntax 7-7'])
  })

  it('indexes every def of an indented block, and the next top-level definition still lands', async () => {
    const content = ['extension (c: Circle)', '  def area: Double = c.r * c.r', '  def diameter: Double =', '    c.r * 2', '', 'extension [T](xs: List[T])(using ord: Ordering[T])', '  def biggest: T = xs.max', '', 'def after(): Int = 3', ''].join('\n')
    expect(await summary(content)).toEqual(['function area  2-2', 'function diameter  3-4', 'function biggest  7-7', 'function after  9-9'])
  })

  it('indexes a braced block without taking the defs of a method body inside it', async () => {
    const content = ['extension (s: String) {', '  def shout: String = {', '    def local(): Int = 1', '    s.toUpperCase', '  }', '  def whisper: String = s.toLowerCase', '}', '', 'val after = 1', ''].join('\n')
    expect(await summary(content)).toEqual(['function shout  2-5', 'function whisper  6-6', 'val after  9-9'])
  })

  it('parents a block inside a braced or an indentation-syntax object to that object', async () => {
    const content = ['object Braced {', '  extension (i: Int)', '    def cubed: Int = i * i * i', '  def plain(): Int = 1', '}', '', 'object Colon:', '  extension (d: Double)', '    def half: Double = d / 2', '  def other(): Int = 2', '', 'def after(): Int = 3', ''].join('\n')
    expect(await summary(content)).toEqual(['object Braced  1-5', 'function cubed Braced 3-3', 'function plain Braced 4-4', 'object Colon  7-10', 'function half Colon 9-9', 'function other Colon 10-10', 'function after  12-12'])
  })

  it('reads past a string holding a parenthesis in the clause', async () => {
    const content = ['extension (s: String = ")") def padded: String = s', ''].join('\n')
    expect(await summary(content)).toEqual(['function padded  1-1'])
  })

  // The over-fix control: `extension` is a soft keyword, so a value or a definition spelled with it is not a clause.
  it('leaves a value named extension alone', async () => {
    const content = ['val extension = "scala"', 'def extensionOf(path: String): String = path', ''].join('\n')
    expect(await summary(content)).toEqual(['val extension  1-1', 'function extensionOf  2-2'])
  })
})
