/** Scala 3 given instances (Scala 3 Reference, "Contextual Abstractions" > "Given Instances") were not indexed: no pattern spelled the `given` keyword, so `symbol intOrd` found nothing and the members of a given's body were dropped or attributed to nothing. These go through the real parseFile, brace spans included. */
import { describe, expect, it } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

async function summary(content: string): Promise<string[]> {
  const { symbols } = await parseFixture('Givens.scala', content)
  return [...symbols].sort((a, b) => a.lineStart - b.lineStart).map((s) => `${s.kind} ${s.name} ${s.parent ?? ''} ${s.lineStart}-${s.lineEnd}`)
}

describe('parseFile on Scala: given instances', () => {
  // FORMAT-DERIVED: the `with` forms, the alias given and the anonymous-given names below are the examples on https://scala-lang.org/api/3.3_LTS/docs/docs/reference/contextual/givens.html (`given intOrd: Ord[Int] with`, `given listOrd[T](using ord: Ord[T]): Ord[List[T]] with`, `given Ord[Int] with` named `given_Ord_Int`, `given global: ExecutionContext = ForkJoinPool()`).
  it('indexes named, parameterized, anonymous and alias givens in the `with` form, with their members', async () => {
    const content = [
      'trait Ord[T]:',
      '  def compare(x: T, y: T): Int',
      '',
      'given intOrd: Ord[Int] with',
      '  def compare(x: Int, y: Int) =',
      '    if x < y then -1 else if x > y then +1 else 0',
      '',
      'given listOrd[T](using ord: Ord[T]): Ord[List[T]] with',
      '  def compare(xs: List[T], ys: List[T]): Int = 0',
      '',
      'given Ord[String] with',
      '  def compareS(x: String, y: String) = 0',
      '',
      'given global: ExecutionContext = ForkJoinPool()',
      '',
      'def after(): Int = 1',
      '',
    ].join('\n')
    expect(await summary(content)).toEqual([
      'trait Ord  1-2',
      'function compare Ord 2-2',
      'object intOrd  4-6',
      'function compare intOrd 5-6',
      'object listOrd  8-9',
      'function compare listOrd 9-9',
      'object given_Ord_String  11-12',
      'function compareS given_Ord_String 12-12',
      'val global  14-14',
      'function after  16-16',
    ])
  })

  // FORMAT-DERIVED: https://docs.scala-lang.org/scala3/reference/contextual/givens.html (Scala 3.6+: `given intOrd: Ord[Int]:`, `given listOrd: [T: Ord] => Ord[List[T]]:`, and the anonymous `given [T: Ord] => Ord[List[T]]` named `given_Ord_List`); `end given` closes an anonymous given per "Other New Features" > "Optional Braces" > "End Markers".
  it('indexes the Scala 3.6 colon form, named and anonymous, and an `end given` marker closes the anonymous one', async () => {
    const content = [
      'given intOrd: Ord[Int]:',
      '  def compare(x: Int, y: Int): Int = 0',
      '',
      'given listOrd: [T: Ord] => Ord[List[T]]:',
      '  def compare(xs: List[T], ys: List[T]): Int = 0',
      '',
      'given [T: Ord] => Ord[List[T]]:',
      '  def anon(xs: List[T]): Int = 0',
      'end given',
      '',
      'val after = 1',
      '',
    ].join('\n')
    expect(await summary(content)).toEqual([
      'object intOrd  1-2',
      'function compare intOrd 2-2',
      'object listOrd  4-5',
      'function compare listOrd 5-5',
      'object given_Ord_List  7-9',
      'function anon given_Ord_List 8-8',
      'val after  11-11',
    ])
  })

  // HAND-DERIVED: placements of the forms above inside a braced and an indentation-syntax object, an abstract given in a trait, and a pattern that only looks like one.
  it('parents givens nested in braced and indentation-syntax objects, and the members after them stay with the object', async () => {
    const content = [
      'object Instances {',
      '  given doubleOrd: Ord[Double] with {',
      '    def compareD(x: Double, y: Double): Int = 0',
      '  }',
      '  def after(): Int = 1',
      '}',
      '',
      'object Instances3:',
      '  given floatOrd: Ord[Float] with',
      '    def compareF(x: Float, y: Float): Int = 0',
      '  def after3(): Int = 3',
      '',
      'trait Ctx:',
      '  given c: Context',
      '  def use(): Int = 1',
      '',
    ].join('\n')
    expect(await summary(content)).toEqual([
      'object Instances  1-6',
      'object doubleOrd Instances 2-4',
      'function compareD doubleOrd 3-3',
      'function after Instances 5-5',
      'object Instances3  8-11',
      'object floatOrd Instances3 9-10',
      'function compareF floatOrd 10-10',
      'function after3 Instances3 11-11',
      'trait Ctx  13-15',
      'val c Ctx 14-14',
      'function use Ctx 15-15',
    ])
  })

  // The over-fix controls: a `case given` pattern and a `given` import declare nothing.
  it('leaves a given pattern and a given import alone', async () => {
    const content = ['import A.given', 'object M {', '  def f(x: Any) = x match', '    case given Ord[Int] => 1', '}', ''].join('\n')
    expect(await summary(content)).toEqual(['object M  2-5', 'function f M 3-3'])
  })
})
