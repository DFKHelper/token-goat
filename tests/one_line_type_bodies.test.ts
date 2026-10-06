/** Members declared on the same line as their type's `{`, or after another member on one line, are indexed with their own spans. PROVENANCE: HAND-DERIVED. Each expected row and span is counted by hand from the fixture lines in its test, independently of the extractors; the member syntax is ordinary PHP (PHP Manual, "Classes and Objects", "Interfaces", "Traits", "Enumerations") and Kotlin (Kotlin language reference, "Classes", "Object declarations", "Grammar": `classMemberDeclarations` takes members separated by optional semicolons). */
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
})
