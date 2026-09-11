import { describe, it, expect } from 'vitest'
import { extractCsharp } from '../src/languages/csharp.js'
import { extractKotlin } from '../src/languages/kotlin.js'
import { extractScala } from '../src/languages/scala.js'
import { extractSwift } from '../src/languages/swift.js'
import { extractDart } from '../src/languages/dart.js'
import { extractPhp } from '../src/languages/php.js'

/**
 * Per-keyword guard over every declaration-modifier alternation in the hand-written
 * language adapters.
 *
 * Fixture provenance: HAND-DERIVED. Every keyword list below is written from the
 * language's own specification, NOT read off the matcher it exercises, and every
 * fixture line is a legal declaration in that language composed independently of
 * the regex. Sources, all consulted as language references rather than as this
 * repo's source:
 *   - C#: ECMA-334 class_modifier / struct_modifier, plus the `file`, `ref` and
 *     `partial` type modifiers from the C# language reference.
 *   - Kotlin: the Kotlin grammar's `classModifier`, `inheritanceModifier`,
 *     `visibilityModifier`, `platformModifier` and `functionModifier` productions.
 *   - Scala: the Scala 3 reference chapter "Modifiers", including the qualified
 *     access forms `private[X]` / `protected[X]` and the soft modifiers `open`,
 *     `inline`, `transparent` and `infix`.
 *   - Swift: "Declaration Modifiers" in The Swift Programming Language, plus
 *     `nonisolated` on a type declaration (Swift 6 actor-isolation opt-out).
 *   - Dart: the Dart 3 class-modifiers feature specification.
 *   - PHP: the PHP manual's class, method, property and constant modifier lists.
 *
 * The point of the shape is the PER-KEYWORD assertion. A union assertion -- "some
 * modifier form produces some symbol" -- is what let a missing alternative hide
 * behind its siblings in the first place, twice: kotlin's CLASS_HEADER_RE was
 * missing `external`, `final` and `inline`, and csharp's was missing `new`, while
 * every one of their neighbours kept matching. Each case below names the exact
 * symbol that must survive, so a count cannot be satisfied by the wrong symbol.
 */

type Extractor = (content: string, filePath: string) => { symbols: Array<{ name: string }> }

interface ModifierCase {
  /** The modifier keyword under test. */
  keyword: string
  /** A legal declaration in the language, written from its spec, that carries the keyword. */
  source: string
  /** The symbol name that must appear in the extractor's output for this fixture. */
  expect: string
}

interface AdapterCases {
  label: string
  extract: Extractor
  file: string
  cases: ModifierCase[]
}

const CSHARP_TYPE_MODIFIERS: ModifierCase[] = [
  { keyword: 'public', source: 'public class Alpha { }', expect: 'Alpha' },
  { keyword: 'internal', source: 'internal class Alpha { }', expect: 'Alpha' },
  { keyword: 'abstract', source: 'abstract class Alpha { }', expect: 'Alpha' },
  { keyword: 'sealed', source: 'sealed class Alpha { }', expect: 'Alpha' },
  { keyword: 'static', source: 'static class Alpha { }', expect: 'Alpha' },
  { keyword: 'partial', source: 'partial class Alpha { }', expect: 'Alpha' },
  { keyword: 'unsafe', source: 'unsafe class Alpha { }', expect: 'Alpha' },
  { keyword: 'file', source: 'file class Alpha { }', expect: 'Alpha' },
  { keyword: 'readonly', source: 'public readonly struct Alpha { }', expect: 'Alpha' },
  { keyword: 'ref', source: 'public ref struct Alpha { }', expect: 'Alpha' },
  { keyword: 'protected', source: 'public class Outer\n{\n    protected class Alpha { }\n}', expect: 'Alpha' },
  { keyword: 'private', source: 'public class Outer\n{\n    private class Alpha { }\n}', expect: 'Alpha' },
  { keyword: 'new', source: 'public class Outer\n{\n    public new class Alpha { }\n}', expect: 'Alpha' },
]

const KOTLIN_CLASS_MODIFIERS: ModifierCase[] = [
  { keyword: 'public', source: 'public class Alpha', expect: 'Alpha' },
  { keyword: 'internal', source: 'internal class Alpha', expect: 'Alpha' },
  { keyword: 'private', source: 'private class Alpha', expect: 'Alpha' },
  { keyword: 'protected', source: 'class Outer {\n    protected class Alpha\n}', expect: 'Alpha' },
  { keyword: 'open', source: 'open class Alpha', expect: 'Alpha' },
  { keyword: 'abstract', source: 'abstract class Alpha', expect: 'Alpha' },
  { keyword: 'sealed', source: 'sealed class Alpha', expect: 'Alpha' },
  { keyword: 'data', source: 'data class Alpha(val v: Int)', expect: 'Alpha' },
  { keyword: 'inner', source: 'class Outer {\n    inner class Alpha\n}', expect: 'Alpha' },
  { keyword: 'expect', source: 'expect class Alpha', expect: 'Alpha' },
  { keyword: 'actual', source: 'actual class Alpha', expect: 'Alpha' },
  { keyword: 'value', source: 'value class Alpha(val v: Int)', expect: 'Alpha' },
  { keyword: 'annotation', source: 'annotation class Alpha', expect: 'Alpha' },
  { keyword: 'fun', source: 'fun interface Alpha {\n    fun run()\n}', expect: 'Alpha' },
  { keyword: 'external', source: 'external class Alpha', expect: 'Alpha' },
  { keyword: 'final', source: 'final class Alpha', expect: 'Alpha' },
  { keyword: 'inline', source: 'inline class Alpha(val v: Int)', expect: 'Alpha' },
]

const KOTLIN_FUN_MODIFIERS: ModifierCase[] = [
  { keyword: 'public', source: 'public fun alpha() { }', expect: 'alpha' },
  { keyword: 'internal', source: 'internal fun alpha() { }', expect: 'alpha' },
  { keyword: 'private', source: 'private fun alpha() { }', expect: 'alpha' },
  { keyword: 'protected', source: 'class Outer {\n    protected fun alpha() { }\n}', expect: 'alpha' },
  { keyword: 'open', source: 'open class Outer {\n    open fun alpha() { }\n}', expect: 'alpha' },
  { keyword: 'override', source: 'class Outer {\n    override fun alpha() { }\n}', expect: 'alpha' },
  { keyword: 'abstract', source: 'abstract class Outer {\n    abstract fun alpha()\n}', expect: 'alpha' },
  { keyword: 'final', source: 'class Outer {\n    final fun alpha() { }\n}', expect: 'alpha' },
  { keyword: 'suspend', source: 'suspend fun alpha() { }', expect: 'alpha' },
  { keyword: 'inline', source: 'inline fun alpha(body: () -> Unit) { }', expect: 'alpha' },
  { keyword: 'infix', source: 'class Outer {\n    infix fun alpha(other: Int) { }\n}', expect: 'alpha' },
  { keyword: 'operator', source: 'class Outer {\n    operator fun alpha(other: Int) { }\n}', expect: 'alpha' },
  { keyword: 'external', source: 'external fun alpha()', expect: 'alpha' },
  { keyword: 'actual', source: 'actual fun alpha() { }', expect: 'alpha' },
  { keyword: 'expect', source: 'expect fun alpha()', expect: 'alpha' },
  { keyword: 'tailrec', source: 'tailrec fun alpha(n: Int): Int = alpha(n)', expect: 'alpha' },
]

const KOTLIN_VAL_MODIFIERS: ModifierCase[] = [
  { keyword: 'public', source: 'public val MAX_SIZE: Int = 1', expect: 'MAX_SIZE' },
  { keyword: 'internal', source: 'internal val MAX_SIZE: Int = 1', expect: 'MAX_SIZE' },
  { keyword: 'private', source: 'private val MAX_SIZE: Int = 1', expect: 'MAX_SIZE' },
  { keyword: 'protected', source: 'class Outer {\n    protected val MAX_SIZE: Int = 1\n}', expect: 'MAX_SIZE' },
  { keyword: 'const', source: 'const val MAX_SIZE = 1', expect: 'MAX_SIZE' },
  { keyword: 'open', source: 'open class Outer {\n    open val MAX_SIZE: Int = 1\n}', expect: 'MAX_SIZE' },
  { keyword: 'override', source: 'class Outer {\n    override val MAX_SIZE: Int = 1\n}', expect: 'MAX_SIZE' },
  { keyword: 'abstract', source: 'abstract class Outer {\n    abstract val MAX_SIZE: Int\n}', expect: 'MAX_SIZE' },
  { keyword: 'final', source: 'class Outer {\n    final val MAX_SIZE: Int = 1\n}', expect: 'MAX_SIZE' },
  { keyword: 'actual', source: 'actual val MAX_SIZE: Int = 1', expect: 'MAX_SIZE' },
  { keyword: 'expect', source: 'expect val MAX_SIZE: Int', expect: 'MAX_SIZE' },
  { keyword: 'external', source: 'external val MAX_SIZE: Int', expect: 'MAX_SIZE' },
  { keyword: 'inline', source: 'inline val MAX_SIZE: Int get() = 1', expect: 'MAX_SIZE' },
]

const SCALA_MODIFIERS: ModifierCase[] = [
  { keyword: 'private', source: 'private class Alpha { }', expect: 'Alpha' },
  { keyword: 'protected', source: 'class Outer {\n  protected def alpha(): Int = 1\n}', expect: 'alpha' },
  { keyword: 'private[X]', source: 'private[pkg] class Alpha { }', expect: 'Alpha' },
  { keyword: 'private[this]', source: 'class Outer {\n  private[this] val alpha = 1\n}', expect: 'alpha' },
  { keyword: 'protected[X]', source: 'class Outer {\n  protected[pkg] def alpha(): Int = 1\n}', expect: 'alpha' },
  { keyword: 'override', source: 'class Outer {\n  override def alpha(): Int = 1\n}', expect: 'alpha' },
  { keyword: 'final', source: 'final class Alpha { }', expect: 'Alpha' },
  { keyword: 'sealed', source: 'sealed trait Alpha { }', expect: 'Alpha' },
  { keyword: 'abstract', source: 'abstract class Alpha { }', expect: 'Alpha' },
  { keyword: 'implicit', source: 'class Outer {\n  implicit val alpha: Int = 1\n}', expect: 'alpha' },
  { keyword: 'lazy', source: 'class Outer {\n  lazy val alpha: Int = 1\n}', expect: 'alpha' },
  { keyword: 'case', source: 'case class Alpha(v: Int)', expect: 'Alpha' },
  { keyword: 'open', source: 'open class Alpha { }', expect: 'Alpha' },
  { keyword: 'inline', source: 'inline def alpha(x: Int): Int = x', expect: 'alpha' },
  { keyword: 'transparent', source: 'transparent inline def alpha(x: Int): Int = x', expect: 'alpha' },
  { keyword: 'infix', source: 'class Outer {\n  infix def alpha(other: Int): Int = other\n}', expect: 'alpha' },
]

const SWIFT_TYPE_MODIFIERS: ModifierCase[] = [
  { keyword: 'public', source: 'public class Alpha { }', expect: 'Alpha' },
  { keyword: 'private', source: 'private class Alpha { }', expect: 'Alpha' },
  { keyword: 'fileprivate', source: 'fileprivate class Alpha { }', expect: 'Alpha' },
  { keyword: 'internal', source: 'internal class Alpha { }', expect: 'Alpha' },
  { keyword: 'open', source: 'open class Alpha { }', expect: 'Alpha' },
  { keyword: 'package', source: 'package struct Alpha { }', expect: 'Alpha' },
  { keyword: 'final', source: 'final class Alpha { }', expect: 'Alpha' },
  { keyword: 'indirect', source: 'indirect enum Alpha { }', expect: 'Alpha' },
  { keyword: 'distributed', source: 'distributed actor Alpha { }', expect: 'Alpha' },
  { keyword: 'nonisolated', source: 'nonisolated class Alpha { }', expect: 'Alpha' },
]

const SWIFT_MEMBER_MODIFIERS: ModifierCase[] = [
  { keyword: 'static', source: 'class Outer {\n    static func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'final', source: 'class Outer {\n    final func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'class', source: 'class Outer {\n    class func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'override', source: 'class Outer {\n    override func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'mutating', source: 'struct Outer {\n    mutating func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'nonmutating', source: 'struct Outer {\n    nonmutating func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'dynamic', source: 'class Outer {\n    dynamic func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'prefix', source: 'prefix func alpha(v: Int) -> Int { return v }', expect: 'alpha' },
  { keyword: 'postfix', source: 'postfix func alpha(v: Int) -> Int { return v }', expect: 'alpha' },
  { keyword: 'consuming', source: 'struct Outer {\n    consuming func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'borrowing', source: 'struct Outer {\n    borrowing func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'nonisolated', source: 'actor Outer {\n    nonisolated func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'distributed', source: 'distributed actor Outer {\n    distributed func alpha() { }\n}', expect: 'alpha' },
  { keyword: 'optional', source: '@objc protocol Outer {\n    optional func alpha()\n}', expect: 'alpha' },
  { keyword: 'required', source: 'class Outer {\n    required init() { }\n}', expect: 'init' },
  { keyword: 'convenience', source: 'class Outer {\n    convenience init() { }\n}', expect: 'init' },
]

const DART_CLASS_MODIFIERS: ModifierCase[] = [
  { keyword: 'abstract', source: 'abstract class Alpha { }', expect: 'Alpha' },
  { keyword: 'base', source: 'base class Alpha { }', expect: 'Alpha' },
  { keyword: 'interface', source: 'interface class Alpha { }', expect: 'Alpha' },
  { keyword: 'final', source: 'final class Alpha { }', expect: 'Alpha' },
  { keyword: 'sealed', source: 'sealed class Alpha { }', expect: 'Alpha' },
  { keyword: 'mixin', source: 'mixin class Alpha { }', expect: 'Alpha' },
]

const PHP_MODIFIERS: ModifierCase[] = [
  { keyword: 'abstract (class)', source: '<?php\nabstract class Alpha { }', expect: 'Alpha' },
  { keyword: 'final (class)', source: '<?php\nfinal class Alpha { }', expect: 'Alpha' },
  { keyword: 'readonly (class)', source: '<?php\nreadonly class Alpha { }', expect: 'Alpha' },
  { keyword: 'public (method)', source: '<?php\nclass Outer {\n  public function alpha() { }\n}', expect: 'alpha' },
  { keyword: 'protected (method)', source: '<?php\nclass Outer {\n  protected function alpha() { }\n}', expect: 'alpha' },
  { keyword: 'private (method)', source: '<?php\nclass Outer {\n  private function alpha() { }\n}', expect: 'alpha' },
  { keyword: 'static (method)', source: '<?php\nclass Outer {\n  static function alpha() { }\n}', expect: 'alpha' },
  { keyword: 'abstract (method)', source: '<?php\nabstract class Outer {\n  abstract function alpha();\n}', expect: 'alpha' },
  { keyword: 'final (method)', source: '<?php\nclass Outer {\n  final function alpha() { }\n}', expect: 'alpha' },
  { keyword: 'readonly (property)', source: '<?php\nclass Outer {\n  public readonly string $alpha;\n}', expect: 'alpha' },
  { keyword: 'var (property)', source: '<?php\nclass Outer {\n  var $alpha;\n}', expect: 'alpha' },
]

const ADAPTERS: AdapterCases[] = [
  { label: 'csharp type declaration', extract: extractCsharp, file: 'Alpha.cs', cases: CSHARP_TYPE_MODIFIERS },
  { label: 'kotlin class declaration', extract: extractKotlin, file: 'Alpha.kt', cases: KOTLIN_CLASS_MODIFIERS },
  { label: 'kotlin fun declaration', extract: extractKotlin, file: 'Alpha.kt', cases: KOTLIN_FUN_MODIFIERS },
  { label: 'kotlin val declaration', extract: extractKotlin, file: 'Alpha.kt', cases: KOTLIN_VAL_MODIFIERS },
  { label: 'scala declaration', extract: extractScala, file: 'Alpha.scala', cases: SCALA_MODIFIERS },
  { label: 'swift type declaration', extract: extractSwift, file: 'Alpha.swift', cases: SWIFT_TYPE_MODIFIERS },
  { label: 'swift member declaration', extract: extractSwift, file: 'Alpha.swift', cases: SWIFT_MEMBER_MODIFIERS },
  { label: 'dart class declaration', extract: extractDart, file: 'alpha.dart', cases: DART_CLASS_MODIFIERS },
  { label: 'php declaration', extract: extractPhp, file: 'Alpha.php', cases: PHP_MODIFIERS },
]

describe('language adapters: every declaration modifier keeps its declaration indexable', () => {
  it('the guard population is non-empty and every adapter contributes cases', () => {
    expect(ADAPTERS.length).toBe(9)
    for (const adapter of ADAPTERS) {
      expect(adapter.cases.length, `${adapter.label} has no cases`).toBeGreaterThan(5)
    }
    expect(ADAPTERS.reduce((n, a) => n + a.cases.length, 0)).toBeGreaterThanOrEqual(110)
  })

  for (const adapter of ADAPTERS) {
    describe(adapter.label, () => {
      for (const c of adapter.cases) {
        it(`\`${c.keyword}\` does not hide \`${c.expect}\` from the index`, () => {
          const names = adapter.extract(c.source, adapter.file).symbols.map((s) => s.name)
          expect(names, `${adapter.label} / ${c.keyword}: ${JSON.stringify(c.source)}`).toContain(c.expect)
        })
      }
    })
  }
})

describe('language adapters: a soft modifier used as an identifier still resolves to its own name', () => {
  it('scala members named after Scala 3 soft modifiers keep their names', () => {
    const source = 'class Gate {\n  val open = true\n  var inline = 1\n  def infix(x: Int): Int = x\n  def ping(): Unit = ()\n}\n'
    const names = extractScala(source, 'Gate.scala').symbols.map((s) => s.name)
    expect(names).toEqual(['Gate', 'open', 'inline', 'infix', 'ping'])
  })

  it('kotlin properties named after soft modifiers are not swallowed by the modifier group', () => {
    const source = 'class Gate {\n    val EXTERNAL_ONE = 1\n    val INLINE_TWO = 2\n}\n'
    const names = extractKotlin(source, 'Gate.kt').symbols.map((s) => s.name)
    expect(names).toContain('EXTERNAL_ONE')
    expect(names).toContain('INLINE_TWO')
  })

  it('swift declarations named `nonisolated` are unaffected', () => {
    const source = 'class Gate {\n    func nonisolated() { }\n    var nonisolated2: Int = 0\n}\n'
    const names = extractSwift(source, 'Gate.swift').symbols.map((s) => s.name)
    expect(names).toContain('nonisolated')
    expect(names).toContain('nonisolated2')
  })

  it('swift `class` as a member modifier never fabricates a type named after the following keyword', () => {
    const source = [
      'class Gate {',
      '    class func alpha() { }',
      '    class var beta: Int { return 1 }',
      '    class let gamma = 2',
      '    class subscript(i: Int) -> Int { return i }',
      '    func delta() { }',
      '}',
      '',
    ].join('\n')
    const names = extractSwift(source, 'Gate.swift').symbols.map((s) => s.name)
    expect(names).not.toContain('func')
    expect(names).not.toContain('var')
    expect(names).not.toContain('let')
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
    expect(names).toContain('gamma')
    // The real nested type after the `class func` line must still be scoped correctly: the bogus
    // frame the old match pushed was what mis-scoped everything following it.
    expect(names).toContain('delta')
  })

  it('swift types named with a backtick-quoted keyword still index', () => {
    const source = 'class `func` {\n    func alpha() { }\n}\n'
    const names = extractSwift(source, 'Quoted.swift').symbols.map((s) => s.name)
    expect(names).toContain('func')
    expect(names).toContain('alpha')
  })

  it('csharp `new` in an object-creation expression does not fabricate a type symbol', () => {
    const source = 'public class Outer\n{\n    public void Run()\n    {\n        var x = new record(1);\n        var y = new List<int>();\n    }\n}\n'
    const names = extractCsharp(source, 'Outer.cs').symbols.map((s) => s.name)
    expect(names).toEqual(['Outer', 'Run'])
  })
})
