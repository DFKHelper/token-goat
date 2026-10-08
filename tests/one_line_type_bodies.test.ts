/** Members declared on the same line as their type's `{`, or after another member on one line, are indexed with their own spans. PROVENANCE: HAND-DERIVED. Each expected row and span is counted by hand from the fixture lines in its test, independently of the extractors; the member syntax is ordinary PHP (PHP Manual, "Classes and Objects", "Interfaces", "Traits", "Enumerations") and Kotlin (Kotlin language reference, "Classes", "Object declarations", "Grammar": `classMemberDeclarations` takes members separated by optional semicolons) and Scala (Scala Language Specification, "Templates": `TemplateStats` are separated by `semi`; Scala 3 Reference, "Optional Braces") and C# (C# language specification, "Classes": `class_member_declaration`s follow one another with no separator line required) and Swift (The Swift Programming Language, "Declarations": declarations on one line are separated by `;`; "Lexical Structure", "Regular Expression Literals"). */
import { describe, expect, it } from 'vitest'

import { bodySegments } from '../src/languages/body_segments.js'
import { parseFixture } from './helpers/parse-fixture.js'

async function rowsFor(file: string, lines: readonly string[]): Promise<string[]> {
  const { symbols } = await parseFixture(file, `${lines.join('\n')}\n`)
  return symbols
    .map((s) => `${s.kind} ${s.name} ${s.parent ?? ''} ${s.lineStart}-${s.lineEnd}`)
    .sort()
}

describe('bodySegments', () => {
  it('splits at a top-level `;` or block close and stops at the body close', () => {
    const code = 'class A { function f() { return 1; } private $x = 1; const K = 2; } $after;'
    const segs = bodySegments(code, code.indexOf('{') + 1).map((s) => code.slice(s.start, s.end).trim())
    expect(segs).toEqual(['function f() { return 1; }', 'private $x = 1;', 'const K = 2;'])
  })

  it('keeps a lambda argument and a bracketed `;` inside one declaration, and marks a block left open', () => {
    const code = '  val a = run({ 1; 2 }); fun g() { val y = [1; 2]'
    const segs = bodySegments(code, 0)
    expect(segs.map((s) => code.slice(s.start, s.end).trim())).toEqual(['val a = run({ 1; 2 });', 'fun g() { val y = [1; 2]'])
    expect(segs.map((s) => s.open)).toEqual([false, true])
  })

  it('reads past the braces of an interpolation hole, which stripStringLiterals leaves between the kept quotes', () => {
    const code = '  fun s() = " ${x} "; val t = $" {y} "; fun u() = 1 }'
    expect(bodySegments(code, 0).map((s) => code.slice(s.start, s.end).trim())).toEqual(['fun s() = " ${x} ";', 'val t = $" {y} ";', 'fun u() = 1'])
  })
})

describe('PHP one-line type bodies', () => {
  it('indexes every member of a class, interface, trait and enum written on one line', async () => {
    expect(await rowsFor('one.php', [
      '<?php', // 1
      'class Single { public function alpha() { return 1; } private $x = 1; const K = 2; }', // 2
      'interface I1 { public function iface(); }', // 3
      'trait T1 { public function tr() {} }', // 4
      "enum Suit: string { case Hearts = 'H'; case Spades = 'S'; }", // 5
    ])).toEqual([
      'class Single  2-2',
      'const Hearts Suit 5-5',
      'const K Single 2-2',
      'const Spades Suit 5-5',
      'enum Suit  5-5',
      'interface I1  3-3',
      'method alpha Single 2-2',
      'method iface I1 3-3',
      'method tr T1 4-4',
      'trait T1  4-4',
      'var x Single 2-2',
    ])
  })

  it('gives a member on the header line its own span, not the class block', async () => {
    expect(await rowsFor('multi.php', [
      '<?php', // 1
      'class Multi { public function beta() { return 2; }', // 2
      '  public function gamma() { return 3; } }', // 3
      'class Open { public function first() { return 1; } public function second() {', // 4
      '    return 2;', // 5
      '  }', // 6
      '  public $a = 1; public $b = 2;', // 7
      '}', // 8
    ])).toEqual([
      'class Multi  2-3',
      'class Open  4-8',
      'method beta Multi 2-2',
      'method first Open 4-4',
      'method gamma Multi 3-3',
      'method second Open 4-6',
      'var a Open 7-7',
      'var b Open 7-7',
    ])
  })

  it('stores just the member as the body of one that shares its line', async () => {
    const { symbols } = await parseFixture('body.php', '<?php\nclass Single { public function alpha() { return "};"; } const K = 2; }\n')
    expect(symbols.find((s) => s.name === 'alpha')?.body).toBe('public function alpha() { return "};"; }')
    expect(symbols.find((s) => s.name === 'K')?.body).toBe('const K = 2;')
  })

  it('leaves a closure in a one-line method body out', async () => {
    expect(await rowsFor('closure.php', [
      '<?php', // 1
      'class After { public function x() { $f = function () { return 1; }; return $f(); } }', // 2
    ])).toEqual(['class After  2-2', 'method x After 2-2'])
  })
})

describe('Kotlin one-line type bodies', () => {
  it('indexes the members of a class, interface and object written on one line, and those after the first on a body line', async () => {
    expect(await rowsFor('one.kt', [
      'class KTwo { fun ka(): Int { return 1 }; val kv = 2; const val MAX = 3; fun kb() = 4 }', // 1
      'class KThree { fun a() {} fun b() {', // 2
      '    println(1)', // 3
      '  }', // 4
      '  fun c() = 1; fun d() = 2', // 5
      '}', // 6
      'interface KI { fun i(): Int }', // 7
      'object KO { fun o() = 1 }', // 8
    ])).toEqual([
      'class KThree  2-6',
      'class KTwo  1-1',
      'const MAX KTwo 1-1',
      'interface KI  7-7',
      'method a KThree 2-2',
      'method b KThree 2-4',
      'method c KThree 5-5',
      'method d KThree 5-5',
      'method i KI 7-7',
      'method ka KTwo 1-1',
      'method kb KTwo 1-1',
      'method o KO 8-8',
      'object KO  8-8',
    ])
  })

  it('indexes a nested type closed on the line with its own members, and leaves a local function out', async () => {
    expect(await rowsFor('nested.kt', [
      'class KC { companion object { const val MAX = 1; fun make() = KC() }; fun after() = "}{" }', // 1
      'class KL(val f: () -> Int = { 1 }) { fun g() = f() }', // 2
      'class Outer {', // 3
      '  class Inner { fun x() = 1 }; fun y() = 2', // 4
      '  fun z() {', // 5
      '    val s = "{"; fun local() = 3', // 6
      '  }', // 7
      '}', // 8
    ])).toEqual([
      'class Inner Outer 4-4',
      'class KC  1-1',
      'class KL  2-2',
      'class Outer  3-8',
      'const MAX Companion 1-1',
      'method after KC 1-1',
      'method g KL 2-2',
      'method make Companion 1-1',
      'method x Inner 4-4',
      'method y Outer 4-4',
      'method z Outer 5-7',
      'object Companion KC 1-1',
    ])
  })

  it('stores just the member as the body of one that shares its line', async () => {
    const { symbols } = await parseFixture('body.kt', 'class KC { fun ka(): Int { return 1 }; fun after() = "}{" }\n')
    expect(symbols.find((s) => s.name === 'ka')?.body).toBe('fun ka(): Int { return 1 }')
    expect(symbols.find((s) => s.name === 'after')?.body).toBe('fun after() = "}{"')
  })

  it('keeps an interpolated string in its member and indexes the member after it', async () => {
    const { symbols } = await parseFixture('hole.kt', 'class KH { fun s() = "a${x}b"; fun t() = 1 }\n')
    expect(symbols.find((s) => s.name === 's')?.body).toBe('fun s() = "a${x}b";')
    expect(symbols.find((s) => s.name === 't')?.body).toBe('fun t() = 1')
  })
})

describe('Scala one-line type bodies', () => {
  it('indexes the members of an object, class, trait, given and enum written on one line, and those after the first on a body line', async () => {
    expect(await rowsFor('one.scala', [
      'object STwo { def sa(): Int = 1; val sv = 2; var sw = 3; def sb(x: Int): Int = { x + 1 } }', // 1
      'class SThree { def a(): Unit = {}; def b(): Unit = {', // 2
      '    println(1)', // 3
      '  }', // 4
      '  def c(): Int = 1; def d(): Int = 2', // 5
      '}', // 6
      'trait ST { def t(): Int }', // 7
      'given intOrd: Ord[Int] with { def compare(a: Int, b: Int): Int = 0; def max(a: Int): Int = a }', // 8
      'enum Color { case Red, Green; def rgb(): Int = 1 }', // 9
    ])).toEqual([
      'class SThree  2-6',
      'enum Color  9-9',
      'function a SThree 2-2',
      'function b SThree 2-4',
      'function c SThree 5-5',
      'function compare intOrd 8-8',
      'function d SThree 5-5',
      'function max intOrd 8-8',
      'function rgb Color 9-9',
      'function sa STwo 1-1',
      'function sb STwo 1-1',
      'function t ST 7-7',
      'object STwo  1-1',
      'object intOrd  8-8',
      'trait ST  7-7',
      'val sv STwo 1-1',
      'var sw STwo 1-1',
    ])
  })

  it('indexes a nested type closed on the line, a second member in an indentation body, and leaves a local def out', async () => {
    expect(await rowsFor('nested.scala', [
      'object SC { object Inner { def x(): Int = 1 }; def after(): String = "}{" }', // 1
      'class SL(f: () => Int = () => { 1 }) { def g(): Int = f() }', // 2
      'object Colon:', // 3
      '  def p(): Int = 1; def q(): Int = 2', // 4
      '  def r(): Int = 3', // 5
      'object Z { def z(): Unit = {', // 6
      '    val s = "{"; def local(): Int = 3', // 7
      '  }', // 8
      '}', // 9
    ])).toEqual([
      'class SL  2-2',
      'function after SC 1-1',
      'function g SL 2-2',
      'function p Colon 4-4',
      'function q Colon 4-4',
      'function r Colon 5-5',
      'function x Inner 1-1',
      'function z Z 6-8',
      'object Colon  3-5',
      'object Inner SC 1-1',
      'object SC  1-1',
      'object Z  6-9',
    ])
  })

  it('stores just the member as the body of one that shares its line', async () => {
    const { symbols } = await parseFixture('body.scala', 'object SC { def sa(): Int = { 1 }; def after(): String = "}{" }\n')
    expect(symbols.find((s) => s.name === 'sa')?.body).toBe('def sa(): Int = { 1 }')
    expect(symbols.find((s) => s.name === 'after')?.body).toBe('def after(): String = "}{"')
  })

  it('keeps an interpolated string in its member and indexes the member after it', async () => {
    const { symbols } = await parseFixture('hole.scala', 'object SH { def s(): String = s"a${x}b"; def t(): Int = 1 }\n')
    expect(symbols.find((s) => s.name === 's')?.body).toBe('def s(): String = s"a${x}b";')
    expect(symbols.find((s) => s.name === 't')?.body).toBe('def t(): Int = 1')
  })
})

describe('C# one-line type bodies', () => {
  it('indexes the members of a class, struct, interface and record written on one line, and those after the first on a body line', async () => {
    expect(await rowsFor('one.cs', [
      'class COne { public int Ca() { return 1; } public int Cv = 2; public int P { get; set; } }', // 1
      'class CTwo { public CTwo() { } public int Ca() { return 1; }', // 2
      '  public int Cb() => 2; public int Cc() => 3;', // 3
      '  public event EventHandler E1, E2; ~CTwo() { } public static CTwo operator +(CTwo a, CTwo b) => a; public int this[int i] => i; public int Q => 4;', // 4
      '  public int Cd() => 5; public int Ce() {', // 5
      '    return 6;', // 6
      '  }', // 7
      '}', // 8
      'struct S1 { public int X; public int Y() => 1; }', // 9
      'interface I1 { int M(); int N(); }', // 10
      'record R1(int A) { public int B() => A; }', // 11
      'enum En { A, B }', // 12
    ])).toEqual([
      'class COne  1-1',
      'class CTwo  2-8',
      'class R1  11-11',
      'enum En  12-12',
      'interface I1  10-10',
      'method B R1 11-11',
      'method CTwo CTwo 2-2',
      'method Ca COne 1-1',
      'method Ca CTwo 2-2',
      'method Cb CTwo 3-3',
      'method Cc CTwo 3-3',
      'method Cd CTwo 5-5',
      'method Ce CTwo 5-7',
      'method M I1 10-10',
      'method N I1 10-10',
      'method Y S1 9-9',
      'method operator+ CTwo 4-4',
      'method ~CTwo CTwo 4-4',
      'struct S1  9-9',
      'var E1 CTwo 4-4',
      'var E2 CTwo 4-4',
      'var P COne 1-1',
      'var Q CTwo 4-4',
      'var this[] CTwo 4-4',
    ])
  })

  it('indexes a nested type closed on the line, a delegate, and the member after an interpolated string', async () => {
    expect(await rowsFor('nested.cs', [
      'class COut { class CIn { void X() {} } [Obsolete] void After() {} }', // 1
      'class CS { string S() => $"a{x}b"; int T() => 1; }', // 2
      'class CD { delegate void D(); public CD(int a) { } }', // 3
      'class CL { void L() {', // 4
      '    int Local() => 1; Local();', // 5
      '  }', // 6
      '}', // 7
    ])).toEqual([
      'class CD  3-3',
      'class CIn COut 1-1',
      'class CL  4-7',
      'class COut  1-1',
      'class CS  2-2',
      'method After COut 1-1',
      'method CD CD 3-3',
      'method L CL 4-6',
      'method S CS 2-2',
      'method T CS 2-2',
      'method X CIn 1-1',
      'type D CD 3-3',
    ])
  })

  it('stores just the member as the body of one that shares its line', async () => {
    const { symbols } = await parseFixture('body.cs', 'class CB { int A() { return 1; } string S() => "};"; }\n')
    expect(symbols.find((s) => s.name === 'A')?.body).toBe('int A() { return 1; }')
    expect(symbols.find((s) => s.name === 'S')?.body).toBe('string S() => "};";')
  })
})

describe('Swift one-line type bodies', () => {
  it('indexes the members of a struct, class, protocol, enum, extension and actor written on one line, and those after the first on a body line', async () => {
    expect(await rowsFor('one.swift', [
      'struct STwo { var a = 0; var b = 1; func f() -> Int { return 1 }; func g() {} }', // 1
      'class SThree { init() {}; func a() {}; func b() {', // 2
      '    print(1)', // 3
      '  }', // 4
      '  func c() {}; func d() {}; subscript(i: Int) -> Int { i }; deinit {}', // 5
      '}', // 6
      'protocol P1 { associatedtype T; func m(); func n() }', // 7
      'enum E1 { case x; func e() {} }', // 8
      'extension STwo { var c: Int { 2 }; static func h() {} }', // 9
      'actor A1 { let k = 1, j = 2 }', // 10
    ])).toEqual([
      'actor A1  10-10',
      'class SThree  2-6',
      'enum E1  8-8',
      'enum_member x E1 8-8',
      'extension STwo  9-9',
      'method a SThree 2-2',
      'method b SThree 2-4',
      'method c SThree 5-5',
      'method d SThree 5-5',
      'method deinit SThree 5-5',
      'method e E1 8-8',
      'method f STwo 1-1',
      'method g STwo 1-1',
      'method h STwo 9-9',
      'method init SThree 2-2',
      'method m P1 7-7',
      'method n P1 7-7',
      'method subscript SThree 5-5',
      'protocol P1  7-7',
      'struct STwo  1-1',
      'type T P1 7-7',
      'var a STwo 1-1',
      'var b STwo 1-1',
      'var c STwo 9-9',
      'var j A1 10-10',
      'var k A1 10-10',
    ])
  })

  it('indexes a nested type closed on the line, and the member after an interpolated string or a regex literal', async () => {
    expect(await rowsFor('nested.swift', [
      'struct Out { struct In { var x = 0 }; @objc func after() {} }', // 1
      'class SS { func s() -> String { "a\\(x)b" }; func t() {} }', // 2
      'class SR { let r = /\\{/; func u() {} }', // 3
      'class SL { func l() {', // 4
      '    func local() {}; let y = 1', // 5
      '  }', // 6
      '}', // 7
    ])).toEqual([
      'class SL  4-7',
      'class SR  3-3',
      'class SS  2-2',
      'method after Out 1-1',
      'method l SL 4-6',
      'method s SS 2-2',
      'method t SS 2-2',
      'method u SR 3-3',
      'struct In Out 1-1',
      'struct Out  1-1',
      'var r SR 3-3',
      'var x In 1-1',
    ])
  })

  it('stores just the member as the body of one that shares its line', async () => {
    const { symbols } = await parseFixture('body.swift', 'struct SB { func a() -> Int { return 1 }; let s = "};"; let r = /\\{/; func u() {} }\n')
    expect(symbols.find((s) => s.name === 'a')?.body).toBe('func a() -> Int { return 1 }')
    expect(symbols.find((s) => s.name === 's')?.body).toBe('let s = "};";')
    expect(symbols.find((s) => s.name === 'r')?.body).toBe('let r = /\\{/;')
    expect(symbols.find((s) => s.name === 'u')?.body).toBe('func u() {}')
  })
})
