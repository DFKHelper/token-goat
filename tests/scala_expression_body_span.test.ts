/** A Scala definition written `def b: Int = 2` has its whole body on its own line, but assignBraceBlockSpans looked for its body brace on the lines below it up to the next indexed symbol, so an unindexed brace construct in between (a `locally { ... }` block, a braced extension block) was taken as the def's body and `read "f.scala::b"` returned that block too. Scala now ends an `=` body where the expression ends, as Kotlin's identical `fun f() = expr` form already did. These go through the real parseFile. */
import { describe, expect, it } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

async function spans(content: string): Promise<string[]> {
  const { symbols } = await parseFixture('Body.scala', content)
  return [...symbols].sort((a, b) => a.lineStart - b.lineStart).map((s) => `${s.name} ${s.lineStart}-${s.lineEnd}`)
}

describe('parseFile on Scala: an = body ends where its expression ends', () => {
  // HAND-DERIVED: spans read off each fixture by hand, one line per complete `= expr` definition.
  it('keeps a one-line def and val to their own line above an unindexed brace block', async () => {
    const content = ['def b: Int = 2', '', 'locally {', '  println(2)', '}', '', 'object A:', '  val a: Int = 1', '', '  locally {', '    println(1)', '  }', ''].join('\n')
    expect(await spans(content)).toEqual(['b 1-1', 'A 7-12', 'a 8-8'])
  })

  it('keeps a one-line extension method off the braced extension block after it', async () => {
    const content = ['extension [T](xs: List[T])', '  def biggest: T = xs.max', '', 'extension (s: String) {', '  def shout: String = s.toUpperCase', '}', ''].join('\n')
    expect(await spans(content)).toEqual(['biggest 2-2', 'shout 5-5'])
  })

  // The controls: a body that really does run past its line must keep running.
  it('still spans a braced body, a match block and a leading-dot continuation', async () => {
    const content = ['object B {', '  def f(x: Int): Int = {', '    x + 1', '  }', '  def g(x: Int): Int = x match {', '    case 0 => 0', '    case _ => 1', '  }', '  def h(xs: List[Int]): List[Int] = xs', '    .map { x => x + 1 }', '  def k(): Unit = {}', '}', ''].join('\n')
    expect(await spans(content)).toEqual(['B 1-12', 'f 2-4', 'g 5-8', 'h 9-10', 'k 11-11'])
  })

  it('still finds the body brace of a class with no = in its header', async () => {
    const content = ['class C(x: Int = 1)', '    extends AnyRef {', '  def get: Int = x', '}', ''].join('\n')
    expect(await spans(content)).toEqual(['C 1-4', 'get 3-3'])
  })
})
